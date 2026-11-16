/**
 * v72 — RENOMEAÇÃO "Lista de Desejos" → "Programação de Compra".
 *
 * O usuário pediu o novo nome da feature (a lógica continua a mesma: fila
 * Prioridade › Necessário › Desejo, reservas e metodologia). Como a caixinha
 * "Reserva · Programação de Compra" é uma CONTA REAL cujo NOME vive no banco,
 * a migração v54 renomeia a conta existente — sem ela o app criaria uma
 * SEGUNDA conta com o nome novo e a reserva antiga ficaria órfã.
 *
 * Cobre:
 *  · migração v54 renomeia a conta antiga (e não toca em outra conta);
 *  · após a migração, ensureReservaBox NÃO cria conta duplicada;
 *  · reservar continua somando na MESMA caixinha (id preservado);
 *  · as telas exibem o nome novo (título, atalho, fechinha da reserva).
 *  Roda: npx jest src/__tests__/wishlist-renome-programacao.test.ts
 */

import { makeCtx, seedAccount } from '../helpers';
import { runMigrations, MIGRATIONS } from '../../db/migrations';
import { BetterSQLiteDriver } from '../../db/BetterSQLiteDriver';
import { WishlistService, RESERVA_ACCOUNT_NAME } from '../../services/WishlistService';
import { TransactionService } from '../../services/TransactionService';
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..', '..', '..');
const readSrc = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('v72 — migração da caixinha Reserva', () => {
  test('v54 renomeia a conta antiga "Reserva · Lista de Desejos" e preserva id/saldo', async () => {
    // banco JÁ migrado recebe uma conta com o NOME ANTIGO (simula app velho)
    const { db, services } = await makeCtx();
    await db.runAsync(
      `INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance)
       VALUES ('acc-reserva-velha', 'Reserva · Lista de Desejos', 'CASH', 1234, 0)`
    );
    // roda SÓ a migração v54 de novo (idempotência do UPDATE por nome)
    const v54 = MIGRATIONS.find((m) => m.version === 54)!;
    await db.execAsync(v54.sql);

    const acc = await db.getFirstAsync<{ id: string; name: string; initial_balance_cents: number }>(
      'SELECT id, name, initial_balance_cents FROM accounts WHERE id = ?',
      ['acc-reserva-velha']
    );
    expect(acc?.name).toBe('Reserva · Programação de Compra');
    expect(acc?.id).toBe('acc-reserva-velha'); // mesmo id — nada órfão
    expect(acc?.initial_balance_cents).toBe(1234); // saldo intacto

    // ensureReservaBox acha a conta RENOMEADA — não cria segunda
    const boxId = await services.wishlist.ensureReservaBox();
    expect(boxId).toBe('acc-reserva-velha');
    const count = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM accounts WHERE name = ?',
      [RESERVA_ACCOUNT_NAME]
    );
    expect(count?.n).toBe(1);
  });

  test('reservar na caixinha renomeada segue na MESMA conta (transferência real)', async () => {
    const { db, services } = await makeCtx();
    // conta com o nome antigo, já renomeada pela v54
    await db.runAsync(
      `INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance)
       VALUES ('acc-reserva-velha', 'Reserva · Lista de Desejos', 'CASH', 0, 0)`
    );
    await db.execAsync(MIGRATIONS.find((m) => m.version === 54)!.sql);

    const origem = await seedAccount(db, 'Origem V72', 100_000);
    const itemId = await services.wishlist.addItem({
      classificacao: 'PRIORIDADE',
      description: 'Notebook',
      targetCents: 50_000,
    });
    await services.wishlist.reserve({ itemId, amountCents: 20_000, fromAccountId: origem, destination: { kind: 'BOX' } });

    const box = await db.getFirstAsync<{ name: string; n: number }>(
      `SELECT a.name, COUNT(r.id) AS n
         FROM accounts a LEFT JOIN wishlist_reserves r ON r.to_account_id = a.id
        WHERE a.name = ? GROUP BY a.id`,
      [RESERVA_ACCOUNT_NAME]
    );
    expect(box?.name).toBe('Reserva · Programação de Compra');
    expect(box?.n).toBe(1); // a reserva foi para a MESMA caixinha renomeada
    const boxes = await db.getAllAsync('SELECT id FROM accounts WHERE name = ?', [RESERVA_ACCOUNT_NAME]);
    expect(boxes).toHaveLength(1); // NUNCA uma segunda conta
  });

  test('banco NOVO nasce sem conta Reserva (só é criada ao reservar) — v54 não quebra nada', async () => {
    const db = BetterSQLiteDriver.memory();
    const { applied } = await runMigrations(db);
    expect(applied).toContain(54);
    const rows = await db.getAllAsync<{ name: string }>('SELECT name FROM accounts WHERE name LIKE ?', ['Reserva%']);
    expect(rows).toHaveLength(0);
  });
});

describe('v72 — telas com o nome novo "Programação de Compra"', () => {
  test('tela da feature usa o nome novo (título, item, caixinha)', () => {
    const src = readSrc('app/lista-desejos.tsx');
    expect(src).toContain('title="Programação de Compra"');
    expect(src).toContain('Programação de Compra (fora do Saldo)');
    expect(src).not.toContain('Lista de Desejos');
  });

  test('bloco do Fluxo com o nome novo (v88: saiu da tela inicial)', () => {
    // v88: a Programação de Compra ficou SÓ no Fluxo (saiu das Ações rápidas)
    expect(readSrc('app/fluxo.tsx')).toContain('Programação de Compra');
    expect(readSrc('app/index.tsx')).toContain('Reserva Programação de Compra');
    expect(readSrc('app/index.tsx')).not.toContain('label="Programação de Compra"');
  });

  test('Ajustes › Preferencias com o nome novo no toggle', () => {
    const src = readSrc('app/ajustes.tsx');
    expect(src).toContain('label="Programação de Compra"');
    expect(src).not.toContain('label="Lista de Desejos"');
  });

  test('serviço expõe RESERVA_ACCOUNT_NAME com o nome novo', () => {
    expect(RESERVA_ACCOUNT_NAME).toBe('Reserva · Programação de Compra');
  });

  test(' WishlistService segue criando a caixinha FORA do saldo geral', async () => {
    const { db } = await makeCtx();
    const tx = new TransactionService(db);
    const wl = new WishlistService(db, tx);
    const id = await wl.ensureReservaBox();
    const row = await db.getFirstAsync<{ include_in_general_balance: number; name: string }>(
      'SELECT include_in_general_balance, name FROM accounts WHERE id = ?',
      [id]
    );
    expect(row?.name).toBe('Reserva · Programação de Compra');
    expect(row?.include_in_general_balance).toBe(0);
  });
});
