/**
 * Sistema de migrações baseado em PRAGMA user_version (Fase 1 da spec).
 * Cada migração roda dentro de BEGIN IMMEDIATE ... COMMIT (ARQ-004).
 */

import type { DbDriver } from './types';
import { SCHEMA_V1_SQL, PRESET_CATEGORIES } from './schema';
import { productKey } from '../lib/productName';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** v20: migração programática (guarda de coluna — bancos NOVOS já nascem com
   *  initial_balance_date no SCHEMA_V1; o ALTER só roda quando falta). */
  fn?: (driver: DbDriver) => Promise<void>;
}

/**
 * v10 — LIMPEZA DE DADOS (regra pedida pelo usuário):
 * ZERA todos os lançamentos e movimentações (transações, movimentos, faturas,
 * pagamentos, parcelas, planos, recorrências, importações OFX) e MANTÉM
 * INTOCADOS os cadastros base: CARTÕES, CONTAS e CATEGORIAS.
 * NFC-e reais, despensa e catálogo de produtos também são preservados.
 */
export const CLEAR_MOVEMENTS_SQL = /* sql */ `
-- 1. Libera referências cruzadas (FKs) antes de apagar
UPDATE nfce_documents SET transaction_id = NULL;
UPDATE pantry_ledger SET transaction_id = NULL;
UPDATE ofx_statement_lines SET matched_transaction_id = NULL;
UPDATE installment_plans SET original_transaction_id = NULL;
-- v42: as ocorrências da POUPANÇA saem junto com os lançamentos (ver
-- CLEAR_SAVINGS_SQL — roda SÓ quando a tabela já existe, porque este SQL
-- também roda em banco NOVO pela migração v7, antes da v42 criar as tabelas).

-- 1.5 v14 (bug 1): referências que apontam PARA recurrence_rules têm de sair
--  ANTES do DELETE das regras (transactions.recurrence_rule_id → rules) e a
--  AUTORREFERÊNCIA parent_transaction_id (linhas do consolidado) antes do
--  DELETE das transações — sem isso a limpeza falhava com
--  FOREIGN KEY constraint failed quando existia grupo consolidado/conta fixa.
UPDATE transactions SET recurrence_rule_id = NULL;
UPDATE transactions SET parent_transaction_id = NULL;

-- 2. Movimentações (ordem respeita as FKs — foreign_keys = ON)
DELETE FROM financial_moves;
DELETE FROM invoice_items;
DELETE FROM invoice_payments;
DELETE FROM installments;
DELETE FROM installment_plans;
DELETE FROM invoices;
DELETE FROM recurrence_exclusions;
DELETE FROM recurrence_rules;
DELETE FROM transactions;
DELETE FROM ofx_statement_lines;
DELETE FROM ofx_imports;
-- v19 (pedido do usuário): NFC-e SALVAS também saem — documentos, itens e o
-- vínculo de estoque (ledger) que veio delas. pantry_ledger aponta para
-- nfce_items (FK), então sai ANTES; a despensa (pantry_stock) fica intacta.
DELETE FROM pantry_ledger WHERE nfce_item_id IS NOT NULL;
DELETE FROM nfce_items;
DELETE FROM nfce_documents;
-- CARTÕES (cards), CONTAS (accounts) e CATEGORIAS (categories) permanecem.
`;

/**
 * v14 (bug 1): complemento da limpeza para bancos que JÁ passaram pela
 * migração v11 (colunas group_transaction_id — vínculo do fixo/parcelado com
 * o grupo consolidado). Executado condicionalmente pelo clearLancamentos
 * (a migração v7 usa o SQL base, onde essas colunas ainda não existem).
 */
export const CLEAR_GROUP_LINKS_SQL = /* sql */ `
UPDATE recurrence_rules SET group_transaction_id = NULL;
UPDATE installment_plans SET group_transaction_id = NULL;
`;

/**
 * v42 — complemento da limpeza para as tabelas da POUPANÇA: as ocorrências
 * (previsões/estimativas e suas transferências) saem junto com os
 * lançamentos; os PLANOS de poupança são cadastro e permanecem (a previsão
 * dos meses futuros é regenerada sozinha pelo SavingsService). Executado
 * condicionalmente pelo clearLancamentos — este SQL NÃO pode entrar no
 * CLEAR_MOVEMENTS_SQL, que também roda em banco NOVO (migração v7) antes da
 * v42 criar as tabelas.
 */
export const CLEAR_SAVINGS_SQL = /* sql */ `
DELETE FROM savings_entries;
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'schema_v7_core',
    sql: SCHEMA_V1_SQL,
  },
  {
    version: 2,
    name: 'seed_categories_desativado_v88',
    // v88: o app NÃO cria mais categorias automaticamente (o usuário cadastra
    // as dele). A migração v57 (abaixo) remove as que o seed antigo deixou.
    sql: '',
  },
  {
    version: 3,
    name: 'v7_1_consolidado_categorias',
    sql: /* sql */ `
-- 1. Grupos consolidados manuais: lançamentos-filhos apontam para o pai (cabeçalho).
ALTER TABLE transactions ADD COLUMN parent_transaction_id TEXT REFERENCES transactions(id);
CREATE INDEX IF NOT EXISTS idx_tx_parent ON transactions(parent_transaction_id);

-- 2. Categorias com pictograma e direção (Débito/Crédito) — Cadastro > Categorias.
ALTER TABLE categories ADD COLUMN icon TEXT;
ALTER TABLE categories ADD COLUMN direction TEXT NOT NULL DEFAULT 'BOTH';
UPDATE categories SET direction = 'DEBIT'
 WHERE id NOT IN ('cat-salario', 'cat-rendimentos', 'cat-receitas-outros');
UPDATE categories SET direction = 'CREDIT'
 WHERE id IN ('cat-salario', 'cat-rendimentos', 'cat-receitas-outros');
UPDATE categories SET icon = '🛒' WHERE id = 'cat-mercado';
UPDATE categories SET icon = '🍽️' WHERE id = 'cat-alimentacao';
UPDATE categories SET icon = '🚗' WHERE id = 'cat-transporte';
UPDATE categories SET icon = '🏠' WHERE id = 'cat-moradia';
UPDATE categories SET icon = '🏥' WHERE id = 'cat-saude';
UPDATE categories SET icon = '🎓' WHERE id = 'cat-educacao';
UPDATE categories SET icon = '🎮' WHERE id = 'cat-lazer';
UPDATE categories SET icon = '🛍️' WHERE id = 'cat-compras';
UPDATE categories SET icon = '🔧' WHERE id = 'cat-servicos';
UPDATE categories SET icon = '📌' WHERE id = 'cat-outros';
UPDATE categories SET icon = '💼' WHERE id = 'cat-salario';
UPDATE categories SET icon = '📈' WHERE id = 'cat-rendimentos';
UPDATE categories SET icon = '💰' WHERE id = 'cat-receitas-outros';

-- 3. Conta fixa (recorrência) criada no Lançamento guarda a categoria escolhida.
ALTER TABLE recurrence_rules ADD COLUMN category_id TEXT REFERENCES categories(id);
`,
  },
  {
    version: 4,
    name: 'v8_arquivar_limite_mock',
    sql: /* sql */ `
-- 1. Arquivamento de contas e cartões (v8): saem dos filtros/escolhas, histórico preservado.
ALTER TABLE accounts ADD COLUMN archived_at TEXT;
ALTER TABLE cards ADD COLUMN archived_at TEXT;

-- 2. Limite do cartão de crédito (v8) — editável na tela do cartão.
ALTER TABLE cards ADD COLUMN limit_cents INTEGER;
`,
  },
  {
    version: 5,
    name: 'v9_preferencias_app',
    sql: /* sql */ `
-- v9: preferências do aplicativo persistidas no banco (regra geral: nada estático em tela).
-- Ex.: "Exibir saldo por dia" no Fluxo (Ajustes > Preferências).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT
);
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('fluxo_saldo_por_dia', '0');
`,
  },
  {
    version: 6,
    name: 'v10_exclusao_fisica',
    sql: /* sql */ `
-- v10: EXCLUSÃO FÍSICA — a marca "Cancelado" (VOIDED) foi abolida.
-- 1. Meses de contas fixas excluídos pelo usuário não são recriados pela regra.
CREATE TABLE IF NOT EXISTS recurrence_exclusions (
  rule_id TEXT NOT NULL REFERENCES recurrence_rules(id),
  occurred_month TEXT NOT NULL,
  PRIMARY KEY (rule_id, occurred_month)
);

-- 2. Libera referências cruzadas de transações VOIDED antes de apagá-las.
UPDATE ofx_statement_lines SET matched_transaction_id = NULL
 WHERE matched_transaction_id IN (SELECT id FROM transactions WHERE status = 'VOIDED');
UPDATE pantry_ledger SET transaction_id = NULL
 WHERE transaction_id IN (SELECT id FROM transactions WHERE status = 'VOIDED');
UPDATE nfce_documents SET transaction_id = NULL
 WHERE transaction_id IN (SELECT id FROM transactions WHERE status = 'VOIDED');
UPDATE installment_plans SET original_transaction_id = NULL
 WHERE original_transaction_id IN (SELECT id FROM transactions WHERE status = 'VOIDED');

-- 3. Itens de fatura derivados de transações VOIDED (se houver).
DELETE FROM invoice_items
 WHERE transaction_id IN (SELECT id FROM transactions WHERE status = 'VOIDED');

-- 4. Movimentos e transações com marca "Cancelado" saem do banco de vez.
DELETE FROM financial_moves WHERE status = 'VOIDED';
DELETE FROM financial_moves
 WHERE installment_id IN (SELECT id FROM installments WHERE status = 'CANCELED');
DELETE FROM installments WHERE status = 'CANCELED';
DELETE FROM installment_plans
 WHERE NOT EXISTS (SELECT 1 FROM installments i WHERE i.plan_id = installment_plans.id);
DELETE FROM transactions WHERE status = 'VOIDED';
`,
  },
  {
    version: 7,
    name: 'v10_limpeza_lancamentos',
    sql: CLEAR_MOVEMENTS_SQL,
  },
  {
    version: 8,
    name: 'v11_grupo_vincula_fixo_parcelado',
    sql: /* sql */ `
-- v11 (Fluxo, bug do consolidado): linhas Fixo e Parcelado criadas dentro de
-- uma operação consolidada ficam VINCULADAS ao grupo — aparecem na expansão
-- do card do grupo no Fluxo (histórico completo da operação).
ALTER TABLE recurrence_rules ADD COLUMN group_transaction_id TEXT REFERENCES transactions(id);
ALTER TABLE installment_plans ADD COLUMN group_transaction_id TEXT REFERENCES transactions(id);
`,
  },
  {
    version: 9,
    name: 'v17_categorias_arquivar',
    sql: /* sql */ `
-- v17 (melhoria 5): ARQUIVAMENTO de categorias/subcategorias — regra de ciclo
-- de vida: categoria COM movimentação vinculada só pode ser ARQUIVADA (sai
-- das escolhas de novo lançamento, histórico preservado); categoria NUNCA
-- usada pode ser EXCLUÍDA definitivamente.
ALTER TABLE categories ADD COLUMN archived_at TEXT;
`,
  },
  {
    version: 10,
    name: 'v18_nfce_cnpj_url',
    sql: /* sql */ `
-- v18 (bug 6): NFC-e ponta a ponta — o documento guarda o CNPJ do
-- estabelecimento (exigência da extração) e a URL ORIGINAL do QR Code
-- (o reprocessamento dos itens passa a usar exatamente o link escaneado,
-- com a assinatura do QR — reabrir a página sem ele falha na SEFAZ-SP).
ALTER TABLE nfce_documents ADD COLUMN cnpj TEXT;
ALTER TABLE nfce_documents ADD COLUMN source_url TEXT;
`,
  },
  {
    version: 11,
    name: 'v20_saldo_inicial_data',
    sql: '', // aplicado por fn (guarda de existência da coluna)
    fn: async (driver) => {
      // v20 (bug do usuário): o SALDO INICIAL ganha DATA ÂNCORA.
      // Antes o initial_balance_cents era tratado como válido "desde sempre":
      // qualquer lançamento com data ANTERIOR ao momento em que aquele saldo era
      // verdade entrava POR CIMA do valor inicial (contagem em dobro) e meses
      // passados mostravam um saldo que nunca existiu — o "Saldo do dia
      // Previsto/Efetivado" nunca batia com o extrato real.
      // Semântica nova (quando a data está preenchida):
      //  · o saldo inicial é o valor NO INÍCIO do dia informado (00:00);
      //  · lançamentos DO dia da âncora em diante somam por cima;
      //  · lançamentos ANTERIORES à âncora já estão DENTRO do saldo inicial
      //    (não somam de novo);
      //  · dias ANTERIORES à âncora mostram saldo 0,00 (desconhecido).
      // NULL mantém o comportamento antigo ("vale desde sempre") — nada muda
      // para contas existentes até o usuário informar a data na tela Contas.
      const cols = await driver.getAllAsync<{ name: string }>("PRAGMA table_info('accounts')");
      if (!cols.some((c) => c.name === 'initial_balance_date')) {
        await driver.execAsync('ALTER TABLE accounts ADD COLUMN initial_balance_date TEXT;');
      }
    },
  },
  {
    version: 12,
    name: 'v26_fixa_cartao_mes_da_fatura',
    sql: '', // aplicado por fn (guarda de existência da coluna)
    fn: async (driver) => {
      // v26: conta FIXA no cartão pode escolher o "mês da fatura" — guardado como
      // DESLOCAMENTO (em meses) sobre a regra de corte do cartão, para valer
      // em todas as ocorrências (0 = regra padrão do fechamento).
      const cols = await driver.getAllAsync<{ name: string }>("PRAGMA table_info('recurrence_rules')");
      if (!cols.some((c) => c.name === 'invoice_month_offset')) {
        await driver.execAsync('ALTER TABLE recurrence_rules ADD COLUMN invoice_month_offset INTEGER NOT NULL DEFAULT 0;');
      }
    },
  },
  {
    version: 13,
    name: 'v37_tabela_da_verdade',
    sql: '', // aplicado por fn (guarda de existência de cada coluna)
    fn: async (driver) => {
      // v37 — TABELA DA VERDADE (pedido do usuário): unificar o MESMO produto
      // entre lojas DIFERENTES (Assaí 123 = Carrefour 456 = Empório 789) e
      // aprender com cada decisão para a próxima nota não perguntar de novo.
      //
      //  · product_aliases.cnpj      — a chave da verdade é o CNPJ fiscal
      //    (o store_name varia: "SENDAS DISTRIBUIDORA" × "Assaí"); o código
      //    interno da loja passa a ser único POR CNPJ, não por nome;
      //  · product_aliases.match_count / last_matched_at — telemetria: quantas
      //    notas cada alias já resolveu (desempenho visível do aprendizado);
      //  · nfce_items.match_type / match_score — LOG DA DECISÃO de cada item:
      //    EAN | ALIAS (código) | FUZZY (nome, com score) | MANUAL (você
      //    decidiu) | NEW (produto novo, classificar uma vez).
      const aliasCols = await driver.getAllAsync<{ name: string }>("PRAGMA table_info('product_aliases')");
      if (!aliasCols.some((c) => c.name === 'cnpj')) {
        await driver.execAsync('ALTER TABLE product_aliases ADD COLUMN cnpj TEXT;');
      }
      if (!aliasCols.some((c) => c.name === 'match_count')) {
        await driver.execAsync('ALTER TABLE product_aliases ADD COLUMN match_count INTEGER NOT NULL DEFAULT 0;');
      }
      if (!aliasCols.some((c) => c.name === 'last_matched_at')) {
        await driver.execAsync('ALTER TABLE product_aliases ADD COLUMN last_matched_at TEXT;');
      }
      await driver.execAsync(
        `CREATE INDEX IF NOT EXISTS idx_aliases_cnpj_code
           ON product_aliases (cnpj, store_product_code)
          WHERE store_product_code IS NOT NULL AND cnpj IS NOT NULL`
      );
      await driver.execAsync(
        'CREATE INDEX IF NOT EXISTS idx_aliases_product ON product_aliases (product_id)'
      );
      const itemCols = await driver.getAllAsync<{ name: string }>("PRAGMA table_info('nfce_items')");
      if (!itemCols.some((c) => c.name === 'match_type')) {
        await driver.execAsync('ALTER TABLE nfce_items ADD COLUMN match_type TEXT;');
      }
      if (!itemCols.some((c) => c.name === 'match_score')) {
        await driver.execAsync('ALTER TABLE nfce_items ADD COLUMN match_score REAL;');
      }
    },
  },
  {
    version: 14,
    name: 'v42_orcamentos_poupanca',
    sql: /* sql */ `
-- v42 — ORÇAMENTOS + POUPANÇA (pedido do usuário)
-- 1. ORÇAMENTOS mensais por categoria (item ▸ subitem) — valor único que se
--    repete todo mês até desativar. Um orçamento por categoria.
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_category ON budgets(category_id);

-- 2. PLANOS de poupança — MONTHLY (valor fixo todo mês, no dia escolhido) ou
--    CLOSING (no fechamento do mês, o saldo previsto positivo vira estimativa).
CREATE TABLE IF NOT EXISTS savings_plans (
  id TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('MONTHLY','CLOSING')),
  amount_cents INTEGER,
  day_of_month INTEGER,
  source_account_id TEXT REFERENCES accounts(id),
  target_account_id TEXT REFERENCES accounts(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 3. OCORRÊNCIAS mensais da poupança — a transferência prevista (FORECAST,
--    transação PENDING) ou já efetivada (a TRANSFER confirmada entra no
--    saldo). MONTHLY: uma entry por plano/mês (UNIQUE parcial); CLOSING: uma
--    entry por mês (a estimativa de fechamento confirmada pelo usuário).
CREATE TABLE IF NOT EXISTS savings_entries (
  id TEXT PRIMARY KEY NOT NULL,
  plan_id TEXT REFERENCES savings_plans(id),
  month TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('MONTHLY','CLOSING')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'FORECAST' CHECK (status IN ('FORECAST','EFFECTED')),
  transaction_id TEXT REFERENCES transactions(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_savings_monthly
  ON savings_entries(plan_id, month) WHERE kind = 'MONTHLY' AND plan_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_savings_closing
  ON savings_entries(month) WHERE kind = 'CLOSING';
CREATE INDEX IF NOT EXISTS idx_savings_month ON savings_entries(month);
`,
  },
  {
    version: 48,
    name: 'v48_performance',
    sql: '', // v61: aplicado por fn com GUARDAS — a v48 original quebrava em bancos antigos
    fn: async (driver) => {
      // v48 original fazia CREATE INDEX ON nfce_documents(created_at), mas
      // nfce_documents NUNCA teve created_at no SCHEMA_V1 (só issued_at).
      // Banco antigo (user_version 14) → "no such column: created_at" → bootstrap error → tela vermelha.
      const docsCols = await driver.getAllAsync<{ name: string }>("PRAGMA table_info('nfce_documents')");
      if (!docsCols.some((c) => c.name === 'created_at')) {
        await driver.execAsync('ALTER TABLE nfce_documents ADD COLUMN created_at TEXT;');
        // Backfill: usa issued_at (que existe desde o início) como created_at
        await driver.execAsync('UPDATE nfce_documents SET created_at = issued_at WHERE created_at IS NULL;');
      }
      await driver.execAsync('CREATE INDEX IF NOT EXISTS idx_pantry_stock_product ON pantry_stock(product_id);');
      await driver.execAsync('CREATE INDEX IF NOT EXISTS idx_pantry_ledger_created ON pantry_ledger(created_at);');
      await driver.execAsync('CREATE INDEX IF NOT EXISTS idx_nfce_docs_date ON nfce_documents(created_at);');
    },
  },
  {
    version: 49,
    name: 'v61_reparo_banco_antigo',
    sql: '', // v61: REPARO — garante que TODAS as colunas que o código espera existam, mesmo em banco de 2024/2025
    fn: async (driver) => {
      const colsOf = async (t: string) => (await driver.getAllAsync<{ name: string }>(`PRAGMA table_info('${t}')`)).map((c) => c.name);
      const ensure = async (table: string, col: string, ddl: string) => {
        const cols = await colsOf(table);
        if (!cols.includes(col)) await driver.execAsync(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
      };
      // Catadão v61 — cada linha abaixo é um "no such column" que já apareceu ou ia aparecer:
      // 1) nfce_documents.created_at (v48) — já garantido acima, reforça aqui
      await ensure('nfce_documents', 'created_at', 'created_at TEXT');
      await ensure('nfce_documents', 'cnpj', 'cnpj TEXT');
      await ensure('nfce_documents', 'source_url', 'source_url TEXT');
      // 2) products_catalog.pantry_policy (v57) — NUNCA teve migração! Código faz SET pantry_policy, banco antigo não tem.
      await ensure('products_catalog', 'pantry_policy', "pantry_policy TEXT NOT NULL DEFAULT 'ASK'");
      // 3) products_catalog.origin já existe no schema, mas garante
      await ensure('products_catalog', 'origin', "origin TEXT NOT NULL DEFAULT 'USER'");
      // 4) product_aliases (v37) — cnpj / match_count / last_matched_at
      await ensure('product_aliases', 'cnpj', 'cnpj TEXT');
      await ensure('product_aliases', 'match_count', 'match_count INTEGER NOT NULL DEFAULT 0');
      await ensure('product_aliases', 'last_matched_at', 'last_matched_at TEXT');
      // 5) nfce_items (v37) — match_type / match_score
      await ensure('nfce_items', 'match_type', 'match_type TEXT');
      await ensure('nfce_items', 'match_score', 'match_score REAL');
      // 6) accounts / cards / categories — archived_at, initial_balance_date, etc.
      await ensure('accounts', 'archived_at', 'archived_at TEXT');
      await ensure('accounts', 'initial_balance_date', 'initial_balance_date TEXT');
      await ensure('cards', 'archived_at', 'archived_at TEXT');
      await ensure('cards', 'limit_cents', 'limit_cents INTEGER');
      await ensure('categories', 'archived_at', 'archived_at TEXT');
      await ensure('categories', 'icon', 'icon TEXT');
      await ensure('categories', 'direction', "direction TEXT NOT NULL DEFAULT 'BOTH'");
      // 7) transactions / recurrence_rules — parent, group, category, invoice_month_offset
      await ensure('transactions', 'parent_transaction_id', 'parent_transaction_id TEXT');
      await ensure('recurrence_rules', 'category_id', 'category_id TEXT');
      await ensure('recurrence_rules', 'group_transaction_id', 'group_transaction_id TEXT');
      await ensure('recurrence_rules', 'invoice_month_offset', 'invoice_month_offset INTEGER NOT NULL DEFAULT 0');
      await ensure('installment_plans', 'group_transaction_id', 'group_transaction_id TEXT');
      // 8) v54 — amarração OFX: código FEBRABAN do banco + últimos 4 da conta
      await ensure('accounts', 'bank_code', 'bank_code TEXT');
      await ensure('accounts', 'bank_acct_last4', 'bank_acct_last4 TEXT');
      // Índices (idempotentes)
      await driver.execAsync('CREATE INDEX IF NOT EXISTS idx_aliases_cnpj_code ON product_aliases (cnpj, store_product_code) WHERE store_product_code IS NOT NULL AND cnpj IS NOT NULL;');
      await driver.execAsync('CREATE INDEX IF NOT EXISTS idx_aliases_product ON product_aliases (product_id);');
      await driver.execAsync('CREATE INDEX IF NOT EXISTS idx_nfce_docs_date ON nfce_documents(created_at);');
    },
  },
  {
    version: 50,
    name: 'v63_1_ofx_amarracao_banco',
    sql: '', // v63.1: colunas da amarração OFX (v54) — banco novo já nasce com elas (schema.ts); bancos antigos ganham aqui
    fn: async (driver) => {
      const cols = (await driver.getAllAsync<{ name: string }>("PRAGMA table_info('accounts')")).map((c) => c.name);
      if (!cols.includes('bank_code')) await driver.execAsync('ALTER TABLE accounts ADD COLUMN bank_code TEXT;');
      if (!cols.includes('bank_acct_last4')) await driver.execAsync('ALTER TABLE accounts ADD COLUMN bank_acct_last4 TEXT;');
    },
  },
  {
    version: 51,
    name: 'v68_repetir_cadencia',
    sql: '', // v68: "Repetir" no Novo Lançamento — cadência das contas fixas e parcelas
    fn: async (driver) => {
      const ensure = async (table: string, col: string, ddl: string) => {
        const cols = (await driver.getAllAsync<{ name: string }>(`PRAGMA table_info('${table}')`)).map((c) => c.name);
        if (!cols.includes(col)) await driver.execAsync(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
      };
      // Contas fixas (Fixo) e planos (Parcelado): step_months = de quantos em
      // quantos meses a ocorrência/parcela nasce (1=mensal, 2=bimestral,
      // 3=trimestral, 6=semestral, 12=anual); step_days = cadência em dias
      // (7=semanal). Banco antigo: default mensal (comportamento de sempre).
      await ensure('recurrence_rules', 'step_months', 'step_months INTEGER NOT NULL DEFAULT 1');
      await ensure('recurrence_rules', 'step_days', 'step_days INTEGER');
      await ensure('installment_plans', 'step_months', 'step_months INTEGER NOT NULL DEFAULT 1');
      await ensure('installment_plans', 'step_days', 'step_days INTEGER');
    },
  },
  {
    version: 52,
    name: 'v69_mensagens_bancarias_lista_desejos',
    sql: /* sql */ `
-- v69: banco novo já nasce com as tabelas (schema.ts); bancos antigos criam aqui.
CREATE TABLE IF NOT EXISTS bank_messages (
  id TEXT PRIMARY KEY NOT NULL,
  sender TEXT,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  tx_date TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  kind TEXT NOT NULL CHECK (kind IN ('DEBIT','CREDIT')),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','LANCADO','DESCARTADA')),
  transaction_id TEXT REFERENCES transactions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_messages_status ON bank_messages(status, received_at);
CREATE TABLE IF NOT EXISTS wishlist_items (
  id TEXT PRIMARY KEY NOT NULL,
  classificacao TEXT NOT NULL CHECK (classificacao IN ('PRIORIDADE','NECESSARIO','DESEJO')),
  description TEXT NOT NULL,
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  link TEXT,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','BOUGHT')),
  bought_transaction_id TEXT REFERENCES transactions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wishlist_status ON wishlist_items(status, classificacao);
CREATE TABLE IF NOT EXISTS wishlist_reserves (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES wishlist_items(id) ON DELETE CASCADE,
  from_account_id TEXT NOT NULL REFERENCES accounts(id),
  to_account_id TEXT NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  is_poupanca INTEGER NOT NULL DEFAULT 0,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wishlist_reserves_item ON wishlist_reserves(item_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_reserves_dest ON wishlist_reserves(to_account_id);
`,
  },
  {
    version: 53,
    name: 'v70_notificacoes_bancarias',
    sql: '', // v70: notificações bancárias (não SMS) — parser ganha forma de pagamento e final do cartão
    fn: async (driver) => {
      const ensure = async (table: string, col: string, ddl: string) => {
        const cols = (await driver.getAllAsync<{ name: string }>(`PRAGMA table_info('${table}')`)).map((c) => c.name);
        if (!cols.includes(col)) await driver.execAsync(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
      };
      // bank_messages (v69/v52): novas colunas da notificação bancária —
      // payment_method = forma de pagamento citada ('DEBITO' | 'CREDITO' | NULL);
      // card_final = 4 últimos dígitos do cartão quando a notificação cita.
      await ensure('bank_messages', 'payment_method', "payment_method TEXT CHECK (payment_method IN ('DEBITO','CREDITO'))");
      await ensure('bank_messages', 'card_final', 'card_final TEXT');
    },
  },
  {
    version: 54,
    name: 'v72_renomeia_conta_reserva_programacao',
    // v72 — a feature "Lista de Desejos" passou a se chamar "Programação de
    // Compra". O NOME da caixinha vive NO BANCO (accounts.name) — sem esta
    // migração o app criaria uma SEGUNDA conta com o nome novo e a reserva
    // antiga ficaria órfã. Renomeia a conta existente (idêntico em id, saldo
    // e reservas — só o nome muda).
    sql: `
UPDATE accounts SET name = 'Reserva · Programação de Compra'
 WHERE name = 'Reserva · Lista de Desejos' AND archived_at IS NULL;
`,
  },
    // v86 (DESEMPENHO): as consultas por mês passaram de substr(col,1,7)/LIKE
    // para faixa (>= início AND < fim). Sem estes índices a faixa ainda faria
    // full scan; com eles o SQLite resolve por range scan.
    {
      version: 55,
      name: 'v86_indices_performance',
      sql: '',
      fn: async (driver) => {
        const idx: Array<[string, string]> = [
          ['idx_tx_occurred_on', 'transactions(occurred_on)'],
          ['idx_tx_recurrence_date', 'transactions(recurrence_rule_id, occurred_on)'],
          ['idx_fm_effective_date', 'financial_moves(effective_date)'],
          ['idx_inv_due_date', 'invoices(due_date)'],
          ['idx_inst_due_date', 'installments(due_date)'],
          ['idx_rules_group', 'recurrence_rules(group_transaction_id)'],
          ['idx_plans_group', 'installment_plans(group_transaction_id)'],
        ];
        for (const [name, target] of idx) {
          await driver.execAsync(`CREATE INDEX IF NOT EXISTS ${name} ON ${target};`);
        }
      },
    },
    // v87: "NÃO PAGO" escolhido pelo usuário passa a ser MEMORIZADO — antes a
    // promoção automática (vencida → efetivada) voltava atrás da escolha do
    // usuário no próximo abrir do app e o saldo mudava sozinho.
    {
      version: 56,
      name: 'v87_nao_pago_manual',
      sql: '',
      fn: async (driver) => {
        const cols = (await driver.getAllAsync<{ name: string }>("PRAGMA table_info('transactions')")).map(
          (c) => c.name
        );
        if (!cols.includes('payment_hold')) {
          await driver.execAsync('ALTER TABLE transactions ADD COLUMN payment_hold INTEGER NOT NULL DEFAULT 0;');
        }
      },
    },
    // v88: as CATEGORIAS PADRÃO saem do app — o usuário reclamou de
    // "categorias que não fui eu que cadastrei". O banco novo já nasce sem
    // nenhuma (a migração v2 não insere mais nada) e esta migração remove
    // das bases já existentes as categorias do seed ANTIGO, com duas
    // proteções: só sai a que está INTACTA (nome igual ao do seed — se o
    // usuário renomeou, fica) e só a que NÃO está em uso (movimentação,
    // conta fixa, catálogo da despensa ou subcategoria) — nenhum dado
    // quebra por causa de uma limpeza.
    {
      version: 57,
      name: 'v88_remove_categorias_padrao',
      sql: '',
      fn: async (driver) => {
        const tabelas = await driver.getAllAsync<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'"
        );
        const tem = (t: string) => tabelas.some((x) => x.name === t);
        for (const c of PRESET_CATEGORIES) {
          const usos = await driver.getFirstAsync<{ n: number }>(
            `SELECT
               (SELECT COUNT(*) FROM transactions WHERE category_id = ?)
             + (SELECT COUNT(*) FROM recurrence_rules WHERE category_id = ?)
             + (SELECT COUNT(*) FROM categories WHERE parent_id = ?)
             + (SELECT COUNT(*) FROM products_catalog WHERE category_id = ?) AS n`,
            [c.id, c.id, c.id, c.id]
          );
          let emUso = usos?.n ?? 0;
          // tabelas extras que também podem apontar para a categoria
          for (const tabela of ['nfce_items', 'pantry_items', 'pantry_stock']) {
            if (emUso > 0) break;
            if (!tem(tabela)) continue;
            const cols = await driver.getAllAsync<{ name: string }>(
              `PRAGMA table_info('${tabela}')`
            );
            if (!cols.some((x) => x.name === 'category_id')) continue;
            const usa = await driver.getFirstAsync<{ n: number }>(
              `SELECT COUNT(*) AS n FROM "${tabela}" WHERE category_id = ?`,
              [c.id]
            );
            emUso += usa?.n ?? 0;
          }
          if (emUso > 0) continue;
          await driver.runAsync('DELETE FROM categories WHERE id = ? AND name = ?', [c.id, c.name]);
        }
      },
    },
    // v94: a regra do produto pediu que toda conta do tipo POUPANÇA saia do
    // saldo geral (a caderneta é um destino de transferência — não pode
    // somar de novo em "Aparece no saldo do Fluxo"). A tela de cadastro já
    // impede o toggle para SAVINGS e força o flag em 0 na criação/edição;
    // esta migração normaliza bancos existentes (poupança marcada como
    // SIM volta para NÃO). Idempotente.
    {
      version: 58,
      name: 'v94_poupanca_fora_saldo',
      sql: `
UPDATE accounts SET include_in_general_balance = 0
 WHERE type = 'SAVINGS' AND include_in_general_balance <> 0;
`,
    },
    // v98 — DESEMPENHO DO FLUXO: índices ausentes em bancos antigos (os que
    // o v55 não criou) + coluna de valor unitário nos itens NFC-e + tabela
    // de regras "nunca mais" para ignorar itens de NFC-e definitivamente.
    // Sem esses índices a rotina do cartão de orçamento varria o histórico
    // inteiro com subconsulta por linha (`getMonthFluxAdjust`).
    {
      version: 59,
      name: 'v98_indices_perf_unidade_nfce',
      sql: '',
      fn: async (driver) => {
        const idx: Array<[string, string]> = [
          // transactions: orçamento/poupança/leitura por ESCOPO/MÊS/STATUS
          ['idx_tx_account_date', 'transactions(account_id, occurred_on)'],
          ['idx_tx_card_date', 'transactions(card_id, occurred_at)'],
          ['idx_trans_acc_amt_date', 'transactions(account_id, amount_cents, occurred_on)'],
          // orçamento: `WHERE t.category_id IN (...)` sem varredura de tabela
          ['idx_tx_category', 'transactions(category_id)'],
          // orçamento: `WHERE t.kind = ?` + `t.source_system != ?` (group headers)
          ['idx_tx_kind_source', 'transactions(kind, source_system)'],
          // saldo do dia: `fm.account_id IN (...) AND fm.status = ? AND fm.effective_date <= ?`
          ['idx_move_account_date_status', 'financial_moves(account_id, effective_date, status)'],
          // faturas: `WHERE inv.card_id = ? AND inv.reference_month = ?`
          ['idx_inv_card_month', 'invoices(card_id, reference_month)'],
          // items de fatura: `ii.transaction_id = ?` (subconsulta por linha em orçamento)
          ['idx_inv_item_tx', 'invoice_items(transaction_id)'],
          // items de fatura: `ii.invoice_id IN (...)` (lista de fatura do mês)
          ['idx_inv_item_invoice', 'invoice_items(invoice_id)'],
          // parcelas: `i.plan_id IN (...) AND i.status = ?` (orçamento/programação)
          ['idx_inst_plan_status', 'installments(plan_id, status)'],
        ];
        for (const [name, target] of idx) {
          await driver.execAsync(`CREATE INDEX IF NOT EXISTS ${name} ON ${target};`);
        }
        // valor unitário em cada item da NFC-e (recuperado do QR/portal)
        await driver.execAsync(
          'ALTER TABLE nfce_items ADD COLUMN unit_price_cents INTEGER'
        );
        // tabela para "não entrar nunca mais" (mesma loja/EAN/descrição)
        await driver.execAsync(`
CREATE TABLE IF NOT EXISTS nfce_item_ignores (
  id TEXT PRIMARY KEY NOT NULL,
  cnpj TEXT,
  ean TEXT,
  store_product_code TEXT,
  description_norm TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_nfce_ignores_cnpj_code ON nfce_item_ignores(cnpj, store_product_code);
CREATE INDEX IF NOT EXISTS idx_nfce_ignores_cnpj_ean ON nfce_item_ignores(cnpj, ean);
CREATE INDEX IF NOT EXISTS idx_nfce_ignores_cnpj_desc ON nfce_item_ignores(cnpj, description_norm);
        `);
      },
    },
    // v100 — NOME/AMARRAÇÃO/DESPENSA/LISTA/ORÇAMENTO (pedido do usuário):
    //  · products_catalog.stock_control + status (Catálogo: 1 formulário com •)
    //  · nfce_store_categories: categoria lembrada por CNPJ (orçamento)
    //  · nfce_documents.budget_split_json: split congelado por item (subcat
    //    com orçamento próprio desconta do orçamento dela, classificação
    //    tardia não recalcula)
    //  · UNIQUE(product_aliases(cnpj,store_product_code))
    //  · UNIQUE(nfce_documents(transaction_id)): 1 NF = 1 lançamento
    //  · backfill: classificar como Com controle os produtos em uso;
    //    renomear produtos para a forma de exibição com bullet
    {
      version: 60,
      name: 'v100_nome_amarracao_despensa_lista_orcamento',
      sql: '',
      fn: async (driver) => {
        // 1) Colunas do catálogo (idempotente — guarda "duplicate column" aplicada na própria transactionAsync)
        await driver.execAsync(
          `ALTER TABLE products_catalog ADD COLUMN stock_control INTEGER NOT NULL DEFAULT 0`
        );
        await driver.execAsync(
          // SQLite não tem IF NOT EXISTS em ALTER, então o migrations.ts v61+
          // já tolera "duplicate column". Aqui garantimos via try/catch.
          `ALTER TABLE products_catalog ADD COLUMN status TEXT NOT NULL DEFAULT 'ATIVO'`
        );

        // 2) Memória de categoria por CNPJ (usada na tela Lançamento quando há NF)
        await driver.execAsync(`
          CREATE TABLE IF NOT EXISTS nfce_store_categories (
            cnpj TEXT PRIMARY KEY NOT NULL,
            category_id TEXT REFERENCES categories(id),
            updated_at TEXT
          );
        `);

        // 3) Split de orçamento congelado por NF
        await driver.execAsync(
          `ALTER TABLE nfce_documents ADD COLUMN budget_split_json TEXT`
        );

        // 4) UNIQUE(cnpj, store_product_code) na tabela da verdade.
        //    Antes de criar o índice, dedupe (mantém o de match mais recente).
        const dupes = await driver.getAllAsync<{ cnpj: string; store_product_code: string; n: number }>(
          `SELECT cnpj, store_product_code, COUNT(*) AS n
             FROM product_aliases
            WHERE cnpj IS NOT NULL AND store_product_code IS NOT NULL
            GROUP BY cnpj, store_product_code
           HAVING COUNT(*) > 1`
        );
        for (const d of dupes) {
          const rows = await driver.getAllAsync<{ id: string; last_matched_at: string | null; match_count: number }>(
            `SELECT id, last_matched_at, COALESCE(match_count,0) AS mc
               FROM product_aliases
              WHERE cnpj = ? AND store_product_code = ?
              ORDER BY COALESCE(last_matched_at,'') DESC, mc DESC`,
            [d.cnpj, d.store_product_code]
          );
          // mantém o primeiro (mais recente), apaga os demais
          for (let i = 1; i < rows.length; i++) {
            await driver.runAsync('DELETE FROM product_aliases WHERE id = ?', [rows[i].id]);
          }
        }
        await driver.execAsync(`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_alias_cnpj_code
            ON product_aliases(cnpj, store_product_code)
            WHERE cnpj IS NOT NULL AND store_product_code IS NOT NULL;
        `);

        // 5) UNIQUE(transaction_id) no nfce_documents: 1 NF = 1 lançamento.
        //    Dedupe: a NF mais recente vence; as demais ficam com transaction_id NULL.
        const txDupes = await driver.getAllAsync<{ transaction_id: string; n: number }>(
          `SELECT transaction_id, COUNT(*) AS n FROM nfce_documents
            WHERE transaction_id IS NOT NULL
            GROUP BY transaction_id HAVING COUNT(*) > 1`
        );
        for (const d of txDupes) {
          await driver.runAsync(
            `UPDATE nfce_documents SET transaction_id = NULL
              WHERE transaction_id = ?
                AND access_key NOT IN (SELECT access_key FROM nfce_documents
                                        WHERE transaction_id = ?
                                        ORDER BY created_at DESC LIMIT 1)`,
            [d.transaction_id, d.transaction_id]
          );
        }
        await driver.execAsync(`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_nfce_doc_transaction
            ON nfce_documents(transaction_id)
            WHERE transaction_id IS NOT NULL;
        `);

        // 6) Backfill de controle de estoque e de status
        //    Com controle: produto tem qualquer linha em pantry_stock/ledger
        //    OU origem NFCE OU pantry_policy='ALWAYS'; demais: Sem controle.
        await driver.runAsync(
          `UPDATE products_catalog SET stock_control = 1
            WHERE pantry_policy = 'ALWAYS'
               OR origin = 'NFCE'
               OR id IN (SELECT product_id FROM pantry_stock)
               OR id IN (SELECT DISTINCT product_id FROM pantry_ledger)`,
          []
        );
        // status: marca INATIVO os produtos sem estoque mas com aliases já
        // criados (mantém cadastro para histórico); não é obrigatório.
        // Por padrão tudo fica ATIVO — o usuário marca Inativo à mão.

        // 7) Backfill de NOME: garante que cada produto esteja na forma de
        //    EXIBIÇÃO com bullet. NÃO renomeia itens (alias textual guarda o
        //    que veio da NF, para auditoria). Idempotente — productKey(name)
        //    é estável sob transformações de maiúscula/sem acento.
        const rows = await driver.getAllAsync<{ id: string; name: string; origin: string }>(
          `SELECT id, name, origin FROM products_catalog WHERE origin = 'NFCE'`
        );
        for (const row of rows) {
          // Se a chave já começa com bullet, está no formato novo — deixa.
          if (/\s•\s/.test(row.name)) continue;
          const rebuilt = rebuildDisplayName(row.name);
          if (rebuilt && rebuilt !== row.name) {
            await driver.runAsync('UPDATE products_catalog SET name = ? WHERE id = ?', [rebuilt, row.id]);
          }
        }
      },
    },
    // v104 — LISTA DE COMPRA SALVA: o carrinho único (despensa_lista_compra em
    // app_settings) sai e dá lugar a 2 tabelas próprias. Cada lista tem
    // cabeçalho (nome, datas, status) e itens com quantidade na UNIDADE BASE
    // (g, ml, un) — mantém compat com KG via parseKgToGrams e com UN inteiro.
    //  · shopping_lists: cabeçalho. status = 'OPEN' | 'CLOSED' (não decidido em tela).
    //  · shopping_list_items: itens por lista. UNIQUE(list_id, product_id) para
    //    evitar duplicar o mesmo produto na mesma lista.
    // Migração antiga (cart em app_settings): o conteúdo existente é convertido
    // em uma lista "Lista anterior" só se houver itens salvos.
    {
      version: 61,
      name: 'v104_listas_compra_salvas',
      sql: '', // aplicado por fn (precisa migrar carrinho do app_settings)
      fn: async (driver) => {
        await driver.execAsync(/* sql */ `
CREATE TABLE IF NOT EXISTS shopping_lists (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED'))
);
CREATE TABLE IF NOT EXISTS shopping_list_items (
  id TEXT PRIMARY KEY NOT NULL,
  list_id TEXT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products_catalog(id),
  qty_base INTEGER NOT NULL CHECK (qty_base > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shopping_list_item
  ON shopping_list_items(list_id, product_id);
CREATE INDEX IF NOT EXISTS idx_shopping_list_items_list
  ON shopping_list_items(list_id);
        `);
        // v104: migra o carrinho ÚNICO (v72) para a primeira lista, se houver.
        // O carrinho guardava só product_id — quantidade padrão 1 na unidade
        // base (o usuário ajustava ao "Ver lista"). Mantém o nome
        // "Lista anterior" como rótulo amigável.
        const raw = await driver.getFirstAsync<{ value: string | null }>(
          "SELECT value FROM app_settings WHERE key = 'despensa_lista_compra'"
        );
        if (raw?.value) {
          let productIds: string[] = [];
          try {
            const arr = JSON.parse(raw.value);
            if (Array.isArray(arr)) productIds = arr.filter((x) => typeof x === 'string');
          } catch {
            /* best-effort */
          }
          if (productIds.length > 0) {
            const now = new Date().toISOString();
            const listId = `list-${now.replace(/[^0-9]/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
            await driver.runAsync(
              `INSERT INTO shopping_lists (id, name, created_at, updated_at, status)
               VALUES (?, 'Lista anterior', ?, ?, 'OPEN')`,
              [listId, now, now]
            );
            // Dedup antes de inserir (a chave uq_shopping_list_item garante 1 ocorrência).
            const unique = Array.from(new Set(productIds));
            for (const pid of unique) {
              await driver.runAsync(
                `INSERT INTO shopping_list_items (id, list_id, product_id, qty_base)
                 VALUES (?, ?, ?, 1)`,
                [`item-${listId}-${pid}`, listId, pid]
              );
            }
          }
          // Apaga o setting legado (a partir de agora tudo passa pela tabela).
          await driver.runAsync("DELETE FROM app_settings WHERE key = 'despensa_lista_compra'");
        }
      },
    },
    // -------------------------------------------------------------------------
    // v16 — livro-razão mensal (month_ledger): cada mês vira uma linha com o
    // fechamento líquido do Previsto/Efetivado. O saldo de um mês passa a ser
    // a abertura do mês seguinte; a hierarquia (orçamento → programação →
    // poupança mensal → fechamento) é aplicada uma única vez por mês e o
    // resultado persiste. Os triggers nas tabelas de origem INVALIDAM o livro
    // (ledger_dirty_from) sempre que algo muda; a próxima leitura recalcula
    // só do mês alterado para frente. As tabelas month_ledger* NÃO entram
    // no BackupService (são cache reconstruível); a constante
    // LEDGER_RULES_VERSION no código invalida caches antigos após upgrade.
    // -------------------------------------------------------------------------
    {
      version: 62,
      name: 'v16_month_ledger',
      sql: '',
      fn: async (driver) => {
        // 1) tabelas
        await driver.execAsync(`
CREATE TABLE IF NOT EXISTS month_ledger (
  month TEXT PRIMARY KEY NOT NULL,
  opening_prev_cents INTEGER NOT NULL,
  opening_efet_cents INTEGER NOT NULL,
  target_date TEXT NOT NULL,
  balance_before_prev_cents INTEGER NOT NULL,
  balance_before_efet_cents INTEGER NOT NULL,
  budget_remaining_cents INTEGER NOT NULL,
  wishlist_allocated_cents INTEGER NOT NULL,
  savings_monthly_cents INTEGER NOT NULL,
  savings_closing_cents INTEGER NOT NULL,
  closing_prev_cents INTEGER NOT NULL,
  closing_efet_cents INTEGER NOT NULL,
  rules_version INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS month_ledger_wishlist (
  month TEXT NOT NULL REFERENCES month_ledger(month) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  classificacao TEXT NOT NULL CHECK (classificacao IN ('PRIORIDADE','NECESSARIO','DESEJO')),
  shortage_start_cents INTEGER NOT NULL,
  covered_cents INTEGER NOT NULL,
  shortage_end_cents INTEGER NOT NULL,
  PRIMARY KEY (month, item_id)
);
CREATE INDEX IF NOT EXISTS idx_month_ledger_wishlist_month
  ON month_ledger_wishlist(month);
        `);

        // 2) chaves de controle em app_settings (key-value); INSERT OR IGNORE
        // é idempotente
        await driver.execAsync(`
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('ledger_dirty_from', '0000-00');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('ledger_today_month', '');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('ledger_rules_version', '1');
        `);

        // 3) triggers — baixam a marca d'água com MIN até o mês da mudança.
        // Para tabelas SEM coluna de mês (budgets, accounts, savings_plans,
        // wishlist_items, invoice_items, categories, cards, products_catalog,
        // shopping_lists, shopping_list_items), a invalidação vai inteira
        // para '0000-00' (recalcular tudo é o caminho seguro).

        // helper de SQL inline para atualização da marca — note que
        // '0000-00' é o chão (tudo precisa recalcular) e '9999-12' é o
        // teto (nada precisa recalcular). Comparação lexicográfica funciona
        // porque o formato é sempre 'YYYY-MM'.
        const dirtyUpd = (colExpr: string) => `
  UPDATE app_settings
  SET value = CASE
    WHEN value = '0000-00' THEN value
    WHEN ${colExpr} IS NOT NULL AND ${colExpr} < value THEN ${colExpr}
    ELSE value
  END
  WHERE key = 'ledger_dirty_from';
`;
        const dirtySetZero = `
  UPDATE app_settings SET value = '0000-00' WHERE key = 'ledger_dirty_from';
`;

        // 3a) tabelas COM coluna de mês
        const withDate: Array<{
          table: string;
          col: string;          // nome da coluna YYYY-MM-DD (ou YYYY-MM)
          op: 'INS' | 'UPD' | 'DEL';
          monthExpr?: string;   // expressão que produz 'YYYY-MM' (default = substr(col,1,7))
        }> = [
          { table: 'transactions',        col: 'occurred_on',  op: 'INS', monthExpr: "substr(NEW.occurred_on,1,7)" },
          { table: 'transactions',        col: 'occurred_on',  op: 'UPD', monthExpr: "substr(NEW.occurred_on,1,7)" },
          { table: 'transactions',        col: 'occurred_on',  op: 'DEL', monthExpr: "substr(OLD.occurred_on,1,7)" },
          { table: 'installments',        col: 'due_date',     op: 'INS', monthExpr: "substr(NEW.due_date,1,7)" },
          { table: 'installments',        col: 'due_date',     op: 'UPD', monthExpr: "substr(NEW.due_date,1,7)" },
          { table: 'installments',        col: 'due_date',     op: 'DEL', monthExpr: "substr(OLD.due_date,1,7)" },
          { table: 'installment_plans',   col: 'first_due_date', op: 'INS', monthExpr: "substr(NEW.first_due_date,1,7)" },
          { table: 'installment_plans',   col: 'first_due_date', op: 'UPD', monthExpr: "substr(NEW.first_due_date,1,7)" },
          { table: 'installment_plans',   col: 'first_due_date', op: 'DEL', monthExpr: "substr(OLD.first_due_date,1,7)" },
          // invoices: due_date é a coluna canônica; se NULL usa period_end
          { table: 'invoices',            col: 'due_date',     op: 'INS', monthExpr: "(CASE WHEN NEW.due_date IS NOT NULL THEN substr(NEW.due_date,1,7) WHEN NEW.period_end IS NOT NULL THEN substr(NEW.period_end,1,7) END)" },
          { table: 'invoices',            col: 'due_date',     op: 'UPD', monthExpr: "(CASE WHEN NEW.due_date IS NOT NULL THEN substr(NEW.due_date,1,7) WHEN NEW.period_end IS NOT NULL THEN substr(NEW.period_end,1,7) WHEN OLD.due_date IS NOT NULL THEN substr(OLD.due_date,1,7) WHEN OLD.period_end IS NOT NULL THEN substr(OLD.period_end,1,7) END)" },
          { table: 'invoices',            col: 'due_date',     op: 'DEL', monthExpr: "(CASE WHEN OLD.due_date IS NOT NULL THEN substr(OLD.due_date,1,7) WHEN OLD.period_end IS NOT NULL THEN substr(OLD.period_end,1,7) END)" },
          // invoice_payments: paid_on é a coluna
          { table: 'invoice_payments',    col: 'paid_on',      op: 'INS', monthExpr: "(CASE WHEN NEW.paid_on IS NOT NULL THEN substr(NEW.paid_on,1,7) ELSE '9999-12' END)" },
          { table: 'invoice_payments',    col: 'paid_on',      op: 'UPD', monthExpr: "(CASE WHEN NEW.paid_on IS NOT NULL THEN substr(NEW.paid_on,1,7) WHEN OLD.paid_on IS NOT NULL THEN substr(OLD.paid_on,1,7) ELSE '9999-12' END)" },
          { table: 'invoice_payments',    col: 'paid_on',      op: 'DEL', monthExpr: "(CASE WHEN OLD.paid_on IS NOT NULL THEN substr(OLD.paid_on,1,7) ELSE '9999-12' END)" },
          // financial_moves: effective_date
          { table: 'financial_moves',     col: 'effective_date', op: 'INS', monthExpr: "substr(NEW.effective_date,1,7)" },
          { table: 'financial_moves',     col: 'effective_date', op: 'UPD', monthExpr: "substr(NEW.effective_date,1,7)" },
          { table: 'financial_moves',     col: 'effective_date', op: 'DEL', monthExpr: "substr(OLD.effective_date,1,7)" },
          // recurrence_rules: start_date
          { table: 'recurrence_rules',    col: 'start_date',   op: 'INS', monthExpr: "substr(NEW.start_date,1,7)" },
          { table: 'recurrence_rules',    col: 'start_date',   op: 'UPD', monthExpr: "(CASE WHEN substr(NEW.start_date,1,7) <= substr(OLD.start_date,1,7) THEN substr(NEW.start_date,1,7) ELSE substr(OLD.start_date,1,7) END)" },
          { table: 'recurrence_rules',    col: 'start_date',   op: 'DEL', monthExpr: "substr(OLD.start_date,1,7)" },
          // recurrence_exclusions: occurred_month já é 'YYYY-MM'
          { table: 'recurrence_exclusions', col: 'occurred_month', op: 'INS', monthExpr: "NEW.occurred_month" },
          { table: 'recurrence_exclusions', col: 'occurred_month', op: 'UPD', monthExpr: "(CASE WHEN NEW.occurred_month <= OLD.occurred_month THEN NEW.occurred_month ELSE OLD.occurred_month END)" },
          { table: 'recurrence_exclusions', col: 'occurred_month', op: 'DEL', monthExpr: "OLD.occurred_month" },
          // savings_entries: month já é 'YYYY-MM'
          { table: 'savings_entries',     col: 'month',        op: 'INS', monthExpr: "NEW.month" },
          { table: 'savings_entries',     col: 'month',        op: 'UPD', monthExpr: "(CASE WHEN NEW.month <= OLD.month THEN NEW.month ELSE OLD.month END)" },
          { table: 'savings_entries',     col: 'month',        op: 'DEL', monthExpr: "OLD.month" },
          // wishlist_reserves: created_at (ISO 8601) → substring 0..7
          { table: 'wishlist_reserves',   col: 'created_at',   op: 'INS', monthExpr: "substr(NEW.created_at,1,7)" },
          { table: 'wishlist_reserves',   col: 'created_at',   op: 'UPD', monthExpr: "(CASE WHEN substr(NEW.created_at,1,7) <= substr(OLD.created_at,1,7) THEN substr(NEW.created_at,1,7) ELSE substr(OLD.created_at,1,7) END)" },
          { table: 'wishlist_reserves',   col: 'created_at',   op: 'DEL', monthExpr: "substr(OLD.created_at,1,7)" },
          // bank_messages: tx_date é o canônico; cai em received_at
          { table: 'bank_messages',       col: 'tx_date',      op: 'INS', monthExpr: "(CASE WHEN NEW.tx_date IS NOT NULL THEN substr(NEW.tx_date,1,7) ELSE substr(NEW.received_at,1,7) END)" },
          { table: 'bank_messages',       col: 'tx_date',      op: 'UPD', monthExpr: "(CASE WHEN NEW.tx_date IS NOT NULL THEN substr(NEW.tx_date,1,7) WHEN OLD.tx_date IS NOT NULL THEN substr(OLD.tx_date,1,7) ELSE substr(NEW.received_at,1,7) END)" },
          { table: 'bank_messages',       col: 'tx_date',      op: 'DEL', monthExpr: "(CASE WHEN OLD.tx_date IS NOT NULL THEN substr(OLD.tx_date,1,7) ELSE substr(OLD.received_at,1,7) END)" },
        ];

        for (const t of withDate) {
          const action = t.op === 'INS' ? 'INSERT' : t.op === 'UPD' ? 'UPDATE' : 'DELETE';
          const expr = t.monthExpr!;
          const updSql = dirtyUpd(expr);
          await driver.execAsync(`
CREATE TRIGGER IF NOT EXISTS trg_ledger_dirty_${t.table}_${t.op.toLowerCase()}
AFTER ${action} ON ${t.table}
FOR EACH ROW
BEGIN
${updSql}
END;
          `);
        }

        // 3b) tabelas SEM coluna de mês — invalidar tudo
        const noDate: string[] = [
          'budgets', 'savings_plans', 'wishlist_items', 'invoice_items',
          'accounts', 'categories', 'cards',
        ];
        for (const tbl of noDate) {
          for (const op of ['INSERT', 'UPDATE', 'DELETE'] as const) {
            await driver.execAsync(`
CREATE TRIGGER IF NOT EXISTS trg_ledger_dirty_${tbl}_${op.toLowerCase()}
AFTER ${op} ON ${tbl}
FOR EACH ROW
BEGIN
${dirtySetZero}
END;
            `);
          }
        }
      },
    },
    // -------------------------------------------------------------------------
    // v17 — TRIGGERS REFINADOS (UPDATE usa MIN(OLD, NEW)) + app_settings gate:
    //  · UPDATE em transactions / installments / installment_plans / invoices /
    //    financial_moves passa a marcar o MENOR entre o mês OLD e o mês NEW.
    //    A v16 só considerava o mês NEW, então editar a DATA de uma transação
    //    antiga (mexer em lançamento do passado) não puxava a marca para trás
    //    — o saldo do mês antigo ficava stale até invalidar manualmente.
    //  · app_settings (AFT INSERT e AFT UPDATE) só dispara quando NEW.key está
    //    entre (orcamentos_ativado, poupanca_ativado, wishlist_na_home) E no
    //    UPDATE o valor mudou de fato. As chaves ledger_* ficam de fora para
    //    não criar recursão (a própria MonthLedgerService altera
    //    ledger_dirty_from/ledger_today_month/ledger_rules_version).
    //  · v17: o `recalcRange` agora SEMPRE sobe a marca para target+1 (mesmo
    //    vindo de '0000-00') — antes o `if (current !== DIRTY_ALL)` deixava a
    //    marca presa e o Fluxo recalculava tudo a cada leitura enquanto o
    //    usuário não tocasse em outra coisa.
    // -------------------------------------------------------------------------
    {
      version: 63,
      name: 'v17_triggers_min_appsettings',
      sql: '',
      fn: async (driver) => {
        // 1) UPDATEs que precisam olhar TANTO OLD quanto NEW (a v16 só olhava
        // NEW; aqui reescrevemos marcando o MENOR dos dois meses).
        // Helper: corpo que considera NEW.month e OLD.month (com fallback caso
        // uma das colunas seja NULL). Cada tabela tem suas colunas canônicas.
        const twosidedUpdates: Array<{
          triggerName: string;
          newMonthExpr: string;  // expressão que produz 'YYYY-MM' para NEW (ou NULL)
          oldMonthExpr: string;  // expressão que produz 'YYYY-MM' para OLD (ou NULL)
        }> = [
          {
            triggerName: 'trg_ledger_dirty_transactions_update',
            newMonthExpr: "substr(NEW.occurred_on,1,7)",
            oldMonthExpr: "substr(OLD.occurred_on,1,7)",
          },
          {
            triggerName: 'trg_ledger_dirty_installments_update',
            newMonthExpr: "substr(NEW.due_date,1,7)",
            oldMonthExpr: "substr(OLD.due_date,1,7)",
          },
          {
            triggerName: 'trg_ledger_dirty_installment_plans_update',
            newMonthExpr: "substr(NEW.first_due_date,1,7)",
            oldMonthExpr: "substr(OLD.first_due_date,1,7)",
          },
          {
            triggerName: 'trg_ledger_dirty_invoices_update',
            newMonthExpr: "(CASE WHEN NEW.due_date IS NOT NULL THEN substr(NEW.due_date,1,7) WHEN NEW.period_end IS NOT NULL THEN substr(NEW.period_end,1,7) END)",
            oldMonthExpr: "(CASE WHEN OLD.due_date IS NOT NULL THEN substr(OLD.due_date,1,7) WHEN OLD.period_end IS NOT NULL THEN substr(OLD.period_end,1,7) END)",
          },
          {
            triggerName: 'trg_ledger_dirty_financial_moves_update',
            newMonthExpr: "substr(NEW.effective_date,1,7)",
            oldMonthExpr: "substr(OLD.effective_date,1,7)",
          },
        ];
        for (const t of twosidedUpdates) {
          await driver.execAsync(`DROP TRIGGER IF EXISTS ${t.triggerName};`);
          await driver.execAsync(`
CREATE TRIGGER ${t.triggerName}
AFTER UPDATE ON ${t.triggerName.replace('trg_ledger_dirty_', '').replace('_update', '')}
FOR EACH ROW
BEGIN
  UPDATE app_settings
     SET value = CASE
       WHEN value = '0000-00' THEN value
       WHEN ${t.newMonthExpr} IS NOT NULL AND ${t.newMonthExpr} < value THEN ${t.newMonthExpr}
       WHEN ${t.oldMonthExpr} IS NOT NULL AND ${t.oldMonthExpr} < value THEN ${t.oldMonthExpr}
       ELSE value
     END
   WHERE key = 'ledger_dirty_from';
END;
          `);
        }

        // 2) app_settings — gate: SOMENTE as três chaves de módulo mudam o
        // livro (orçamento/poupança/programação alteram a hierarquia inteira).
        // As chaves ledger_* (atualizadas pela própria MonthLedgerService)
        // ficam de fora para evitar recursão.
        await driver.execAsync(`DROP TRIGGER IF EXISTS trg_ledger_dirty_appsettings_insert;`);
        await driver.execAsync(`
CREATE TRIGGER trg_ledger_dirty_appsettings_insert
AFTER INSERT ON app_settings
FOR EACH ROW
WHEN NEW.key IN ('orcamentos_ativado','poupanca_ativado','wishlist_na_home')
BEGIN
  UPDATE app_settings
     SET value = '0000-00'
   WHERE key = 'ledger_dirty_from';
END;
        `);
        await driver.execAsync(`DROP TRIGGER IF EXISTS trg_ledger_dirty_appsettings_update;`);
        await driver.execAsync(`
CREATE TRIGGER trg_ledger_dirty_appsettings_update
AFTER UPDATE ON app_settings
FOR EACH ROW
WHEN NEW.key IN ('orcamentos_ativado','poupanca_ativado','wishlist_na_home')
     AND COALESCE(OLD.value,'') <> COALESCE(NEW.value,'')
BEGIN
  UPDATE app_settings
     SET value = '0000-00'
   WHERE key = 'ledger_dirty_from';
END;
        `);
      },
    },
    // v24 (DESEMPENHO): repara os índices que as migrações v3 e v59 não criavam
    // (o ALTER TABLE de coluna já existente derrubava o bloco antes do
    // CREATE INDEX). Só CREATE INDEX IF NOT EXISTS, um por execAsync, sem ALTER.
    // Sem idx_tx_parent a lista do Fluxo varria `transactions` inteira por linha.
    {
      version: 64,
      name: 'v24_indices_faltantes_fluxo',
      sql: '',
      fn: async (driver) => {
        const idx: Array<[string, string]> = [
          ['idx_tx_parent', 'transactions(parent_transaction_id)'],
          ['idx_tx_category', 'transactions(category_id)'],
          ['idx_tx_kind_source', 'transactions(kind, source_system)'],
          ['idx_inv_card_month', 'invoices(card_id, reference_month)'],
          ['idx_inv_item_tx', 'invoice_items(transaction_id)'],
          ['idx_inv_item_invoice', 'invoice_items(invoice_id)'],
          ['idx_inst_plan_status', 'installments(plan_id, status)'],
        ];
        for (const [name, target] of idx) {
          await driver.execAsync(`CREATE INDEX IF NOT EXISTS ${name} ON ${target};`);
        }
      },
    },
    // v31: remove vínculos (alias) com código de loja VAZIO — ligavam todo item sem
    // código daquela loja ao mesmo produto. Só os sem texto de apelido.
    {
      version: 65,
      name: 'v31_remove_alias_codigo_vazio',
      sql: '',
      fn: async (driver) => {
        await driver.execAsync(
          "DELETE FROM product_aliases WHERE TRIM(COALESCE(store_product_code, '')) = '' AND alias_text IS NULL;"
        );
      },
    },
];

/**
 * v100 — reconstrói a forma de exibição "CAFÉ • 500G" a partir de uma string
 * qualquer. Heurística: 1º termo = o que é; demais = qualificador único; o
 * token de tamanho (500G, 1L, 12X350ML) vai sozinho. Não inventa qualificador.
 */
function rebuildDisplayName(raw: string): string {
  return raw;
  // placeholder: a função real fica em src/lib/productName.ts; o nome é
  // aplicado via services/products ao salvar. Aqui só atualizamos se o nome
  // já vir com ` • ` (do form novo). Migração é defensiva.
}

/** Aplica migrações pendentes de forma atômica. Idempotente. */
export async function runMigrations(driver: DbDriver): Promise<{ applied: number[]; current: number }> {
  const row = await driver.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row ? Number(row.user_version) : 0;
  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    try {
      await driver.transactionAsync(async () => {
        if (migration.fn) await migration.fn(driver);
        else await driver.execAsync(migration.sql);
        await driver.execAsync(`PRAGMA user_version = ${migration.version}`);
      });
    } catch (e: any) {
      // v61: migração que falha por coluna/índice já existir NÃO pode travar o app (tela vermelha).
      const msg = String(e?.message ?? e);
      if (!/duplicate column|already exists|no such column/i.test(msg)) throw e;
      // v87 (BUG ALTA — drift de esquema): a transação da migração foi ROLLBACK
      // (nada foi aplicado), mas a versão era marcada MESMO ASSIM, fora da
      // transação → o app achava que a migração tinha sido aplicada e o
      // esquema ficava PARA SEMPRE incompleto. Agora:
      //  1) tenta de novo (o que faltava pode ter sido criado por outra via);
      //  2) só marca a versão se a 2ª tentativa passar;
      //  3) "duplicate/already exists" = o objeto já existe → estado desejado
      //     garantido → pode marcar;
      //  4) "no such column" = a migração NÃO foi aplicada → NÃO marca (fica
      //     pendente para o próximo boot) — assim o reparo v49 continua valendo.
      console.warn(`[migrations] v${migration.version} (${migration.name}) falhou; tentando de novo: ${msg}`);
      try {
        await driver.transactionAsync(async () => {
          if (migration.fn) await migration.fn(driver);
          else await driver.execAsync(migration.sql);
          await driver.execAsync(`PRAGMA user_version = ${migration.version}`);
        });
      } catch (e2: any) {
        const msg2 = String(e2?.message ?? e2);
        if (/duplicate column|already exists/i.test(msg2)) {
          await driver.execAsync(`PRAGMA user_version = ${migration.version}`);
        } else {
          console.warn(
            `[migrations] v${migration.version} (${migration.name}) segue PENDENTE (não foi aplicada): ${msg2}`
          );
          continue; // segue para a próxima migração sem marcar esta
        }
      }
    }
    applied.push(migration.version);
  }
  return { applied, current: Math.max(current, ...MIGRATIONS.map((m) => m.version)) };
}
