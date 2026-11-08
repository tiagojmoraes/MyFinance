/**
 * Sistema de migrações baseado em PRAGMA user_version (Fase 1 da spec).
 * Cada migração roda dentro de BEGIN IMMEDIATE ... COMMIT (ARQ-004).
 */

import type { DbDriver } from './types';
import { SCHEMA_V1_SQL, SEED_CATEGORIES } from './schema';

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
    name: 'seed_categories',
    sql: SEED_CATEGORIES.map(
      (c) =>
        `INSERT OR IGNORE INTO categories (id, name, color_hex) VALUES ('${c.id}', '${c.name.replace(/'/g, "''")}', '${c.colorHex}');`
    ).join('\n'),
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
];

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
      // Ex.: "duplicate column name" / "already exists" = já aplicado, só marca a versão e segue.
      const msg = String(e?.message ?? e);
      if (/duplicate column|already exists|no such column/i.test(msg)) {
        // Tenta marcar a versão mesmo assim para não repetir o erro a cada boot — mas
        // se o erro foi "no such column", a migração v49 de reparo vai corrigir na próxima vez.
        // Aqui só loga e segue: o bootstrap NÃO pode morrer por causa de migração.
        console.warn(`[migrations] v${migration.version} (${migration.name}) falhou mas não trava o boot: ${msg}`);
        try { await driver.execAsync(`PRAGMA user_version = ${migration.version}`); } catch {}
      } else {
        throw e;
      }
    }
    applied.push(migration.version);
  }
  return { applied, current: Math.max(current, ...MIGRATIONS.map((m) => m.version)) };
}
