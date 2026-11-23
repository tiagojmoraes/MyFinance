/**
 * Limpeza de dados de usuário e dados de demonstração.
 */

import type { DbDriver } from './types';
import { CLEAR_MOVEMENTS_SQL, CLEAR_GROUP_LINKS_SQL, CLEAR_SAVINGS_SQL, runMigrations } from './migrations';
import { SCHEMA_V1_SQL } from './schema';

/**
 * v86 — "Começar do zero AGORA" (Ajustes › Dados) e limpeza opcional do
 * arranque: apaga os dados de usuário e DEIXA O BANCO COMO O USUÁRIO DEIXOU
 * (categorias, contas e cartões continuam como estão).
 *
 * v88: o app NÃO cria mais categorias padrão — o "Começar do zero agora"
 * também NÃO recria as categorias do seed antigo (o usuário complained de
 * "categorias que não fui eu que cadastrei"). Quem usa, cadastra.
 */
export async function resetUserData(db: DbDriver): Promise<void> {
  await clearAllUserData(db);
}


/** Apaga todos os dados de usuário sem remover o schema ou recriar seeds. */
export async function clearAllUserData(db: DbDriver): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = OFF;');
  try {
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'android_%'"
    );
    await db.transactionAsync(async () => {
      for (const table of tables) {
        await db.execAsync(`DELETE FROM "${table.name.replace(/"/g, '""')}";`);
      }
      // v16: marca o livro-razão para recálculo total — todas as linhas
      // persistidas foram apagadas junto com os lançamentos.
      await db.execAsync(
        `INSERT INTO app_settings (key, value) VALUES ('ledger_dirty_from', '0000-00')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      await db.execAsync('DELETE FROM month_ledger_wishlist;');
      await db.execAsync('DELETE FROM month_ledger;');
    });
  } finally {
    await db.execAsync('PRAGMA foreign_keys = ON;');
  }
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
  // v69: as tabelas das MENSAGENS BANCÁRIAS e da PROGRAMAÇÃO DE COMPRA (migração
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
    // v16: lançamentos, poupança e reservas sumiram → o livro-razão é
    // derivado e precisa ser refeito. Mantém a chave em app_settings
    // para o próximo getMonthLedgerSummary recalcular tudo na hora.
    await db.execAsync(
      `INSERT INTO app_settings (key, value) VALUES ('ledger_dirty_from', '0000-00')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    await db.execAsync('DELETE FROM month_ledger_wishlist;');
    await db.execAsync('DELETE FROM month_ledger;');
  });
}


/**
 * v62 — ZERAR TUDO (só para teste): apaga ABSOLUTAMENTE TUDO — lançamentos,
 * cadastros, produtos, despensa, NFC-e, OFX, orçamentos, poupança — e deixa
 * o banco como se fosse uma primeira abertura.
 * NÃO usa em produção com dado real. Ajustes > Zerar tudo (teste) chama isso.
 */
export async function zerarTudo(db: DbDriver): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = OFF;');
  try {
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'android_%'"
    );
    for (const t of tables) {
      await db.execAsync(`DELETE FROM "${t.name}";`);
    }
    // Reseta o contador de versão para 0 — o próximo boot roda as migrações do zero
    // em cima do schema já novo (v62), sem precisar de reparo.
    await db.execAsync('PRAGMA user_version = 0;');
    // Recria o schema completo (que já vem com todas as colunas v62) e roda migrações
    // v63.1: imports estáticos — await import() quebra o Jest sem --experimental-vm-modules
    await db.execAsync(SCHEMA_V1_SQL);
    await runMigrations(db);
  } finally {
    await db.execAsync('PRAGMA foreign_keys = ON;');
  }
}
