/**
 * DADOS INICIAIS (v10) — CADASTROS BASE + LIMPEZA DE MOVIMENTAÇÕES.
 *
 * REGRA NOVA (v10 — pedido do usuário):
 *  - O banco vem SEM nenhum lançamento/movimentação (zerado).
 *  - Na primeira abertura (banco vazio) são criados apenas os CADASTROS BASE:
 *    contas (uma fora do saldo do Fluxo, p/ demonstrar o toggle) e cartões
 *    (com dia de fechamento/vencimento/limite). As CATEGORIAS já vêm da migração.
 *  - clearLancamentos(db): apaga TODOS os lançamentos e movimentações
 *    (transações, movimentos, faturas, pagamentos, parcelas, planos,
 *    recorrências, OFX) e MANTÉM intocados Cartões, Contas e Categorias
 *    (também preserva NFC-e reais, despensa e catálogo).
 */

import type { DbDriver } from './types';
import { CLEAR_MOVEMENTS_SQL, CLEAR_GROUP_LINKS_SQL, CLEAR_SAVINGS_SQL } from './migrations';

/**
 * Popula apenas os CADASTROS BASE se o banco estiver vazio (primeira abertura
 * em desenvolvimento).
 * Lançamentos/movimentações NÃO são mais criados — o app começa zerado.
 */
const MOCK_SEED_SUPPRESSED_KEY = 'mock_seed_suppressed';

export async function ensureMockData(db: DbDriver, allowDemoData = true): Promise<boolean> {
  if (!allowDemoData) return false;
  const suppressed = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?',
    [MOCK_SEED_SUPPRESSED_KEY]
  );
  if (suppressed?.value === '1') return false;
  const accounts = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM accounts');
  const cards = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM cards');
  const empty = (accounts?.n ?? 0) === 0 && (cards?.n ?? 0) === 0;
  if (!empty) return false;

  // ---------- CONTAS (cadastro base — 1 fora do saldo do Fluxo) ----------
  const insertAccount = (id: string, name: string, type: string, initial: number, include: number) =>
    db.runAsync(
      'INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance, archived_at) VALUES (?,?,?,?,?,NULL)',
      [id, name, type, initial, include]
    );
  await insertAccount('acc-mock-itau', 'Itaú Corrente', 'CHECKING', 250_000, 1);
  await insertAccount('acc-mock-nubank', 'Nubank', 'CHECKING', 80_000, 1);
  await insertAccount('acc-mock-carteira', 'Carteira (dinheiro)', 'CASH', 15_000, 1);
  // Fora do saldo do Fluxo — demonstra o toggle "Aparece no saldo do Fluxo"
  await insertAccount('acc-mock-poupanca', 'Poupança', 'SAVINGS', 500_000, 0);

  // ---------- CARTÕES (cadastro base — com limite) ----------
  await db.runAsync(
    'INSERT INTO cards (id, name, last_four_digits, closing_day, due_day, linked_account_id, limit_cents, archived_at) VALUES (?,?,?,?,?,?,?,NULL)',
    ['card-mock-nubank', 'Nubank Master', '4444', 20, 28, 'acc-mock-nubank', 800_000]
  );
  await db.runAsync(
    'INSERT INTO cards (id, name, last_four_digits, closing_day, due_day, linked_account_id, limit_cents, archived_at) VALUES (?,?,?,?,?,?,?,NULL)',
    ['card-mock-inter', 'Inter', '8888', 5, 15, null, 300_000]
  );
  return true;
}

/**
 * v10 — LIMPAR LANÇAMENTOS E MOVIMENTAÇÕES (Ajustes > Dados):
 * apaga todas as movimentações do banco de verdade e MANTÉM os cadastros base
 * (Cartões, Contas, Categorias), além de NFC-e reais, despensa e catálogo.
 * v14 (bug 1): funciona TAMBÉM com grupos consolidados/contas fixas/parcelamentos
 * existentes — as FKs cruzadas (transactions ↔ recurrence_rules, linhas do
 * grupo) são liberadas antes dos DELETEs. O complemento das colunas
 * group_transaction_id (migração v11) roda só quando elas existem.
 */
export async function clearLancamentos(db: DbDriver): Promise<void> {
  const ruleCols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('recurrence_rules')");
  const hasGroupLinks = ruleCols.some((c) => c.name === 'group_transaction_id');
  // v42: as tabelas da poupança só existem a partir da migração v14 — a
  // limpeza das ocorrências roda SÓ quando a tabela já existe (banco novo,
  // ainda na v7, não tem savings_entries).
  const savingsCols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('savings_entries')");
  const hasSavings = savingsCols.length > 0;
  // v69: as tabelas das MENSAGENS BANCÁRIAS e da LISTA DE DESEJOS (migração
  // v52) — mensagens lançadas voltam para a lista; reservas saem (as
  // transferências delas são apagadas junto com as movimentações) e os itens
  // abertos voltam com reservado = 0.
  const bmCols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('bank_messages')");
  const wishCols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('wishlist_items')");
  const wishResCols = await db.getAllAsync<{ name: string }>("PRAGMA table_info('wishlist_reserves')");
  await db.transactionAsync(async () => {
    if (hasGroupLinks) await db.execAsync(CLEAR_GROUP_LINKS_SQL);
    if (hasSavings) await db.execAsync(CLEAR_SAVINGS_SQL);
    if (wishResCols.length > 0) await db.execAsync('DELETE FROM wishlist_reserves;');
    if (wishCols.length > 0) {
      await db.execAsync(`DELETE FROM wishlist_items WHERE status = 'BOUGHT';`);
      await db.execAsync(`UPDATE wishlist_items SET reserved_cents = 0, bought_transaction_id = NULL;`);
    }
    if (bmCols.length > 0) {
      // v69: mensagens JÁ LANÇADAS saem (o lançamento delas foi apagado);
      // as que estavam na lista permanecem esperando decisão.
      await db.execAsync(`DELETE FROM bank_messages WHERE status = 'LANCADO';`);
      await db.execAsync(`UPDATE bank_messages SET transaction_id = NULL, status = 'NEW' WHERE status != 'DESCARTADA';`);
    }
    await db.execAsync(CLEAR_MOVEMENTS_SQL);
  });
}


/**
 * Apaga todos os registros mantendo o schema, sem semear dados de demonstração
 * novamente no próximo boot.
 */
export async function zerarTudo(db: DbDriver): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = OFF;');
  try {
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'android_%'"
    );
    await db.transactionAsync(async () => {
      for (const t of tables) {
        await db.execAsync(`DELETE FROM "${t.name}";`);
      }
      await db.runAsync(
        'INSERT INTO app_settings (key, value) VALUES (?, ?)',
        [MOCK_SEED_SUPPRESSED_KEY, '1']
      );
    });
  } finally {
    await db.execAsync('PRAGMA foreign_keys = ON;');
  }
}
