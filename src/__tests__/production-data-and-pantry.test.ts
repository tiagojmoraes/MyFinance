import { BetterSQLiteDriver } from '../db/BetterSQLiteDriver';
import { runMigrations } from '../db/migrations';
import { ensureMockData, zerarTudo } from '../db/seed';
import { subtractAllocationsCents } from '../lib/flowAllocations';
import { sumConsolidatedLineAmounts } from '../lib/consolidatedTotals';
import { makeCtx, seedAccount } from './helpers';

describe('v72 — cálculo do consolidado', () => {
  test('soma débitos e créditos de todas as modalidades do grupo', () => {
    expect(sumConsolidatedLineAmounts([
      { dir: 'DEBIT', cents: 10000 },
      { dir: 'DEBIT', cents: 2500 },
      { dir: 'CREDIT', cents: 4300 },
      { dir: 'CREDIT', cents: 0 },
    ])).toEqual({ debitCents: 12500, creditCents: 4300 });
  });
});

describe('v72 — alocações e produção sem dados', () => {
  test('subtrai as reservas de orçamento e lista de desejos do saldo', () => {
    expect(subtractAllocationsCents(150000, [135000, 3000])).toBe(12000);
    expect(subtractAllocationsCents(1000, [800, 700])).toBe(-500);
  });

  test('instalação de produção não semeia categorias nem cadastros de demonstração', async () => {
    const db = BetterSQLiteDriver.memory();
    await runMigrations(db, { seedCategories: false });
    expect(await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM categories')).toEqual({ n: 0 });
    expect(await ensureMockData(db, false)).toBe(false);
    expect(await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')).toEqual({ n: 0 });
    expect(await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM cards')).toEqual({ n: 0 });
  });
});

describe('v72 — zerar toda a base', () => {
  test('apaga registros e preferências e impede o seed de demonstração', async () => {
    const { db, services } = await makeCtx();
    await seedAccount(db, 'Conta a zerar', 12345);
    await services.settings.setBool('fluxo_saldo_por_dia', true);
    await services.transactions.createAccountExpense({
      description: 'Despesa para limpeza',
      amountCents: 1200,
      accountId: (await db.getFirstAsync<{ id: string }>('SELECT id FROM accounts LIMIT 1'))!.id,
    });

    await zerarTudo(db);

    for (const table of ['accounts', 'cards', 'categories', 'transactions', 'financial_moves']) {
      expect(await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)).toEqual({ n: 0 });
    }
    expect(await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'mock_seed_suppressed'"
    )).toEqual({ value: '1' });
    expect(await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'fluxo_saldo_por_dia'"
    )).toBeNull();
    expect(await ensureMockData(db, true)).toBe(false);
    expect(await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')).toEqual({ n: 0 });
    expect(await db.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
  });
});

describe('v72 — unidades de medida', () => {
  test('registra unidade não padronizada recebida na NFC-e', async () => {
    const { services, db } = await makeCtx();
    await services.products.ensureMeasurementUnit(' CX ');
    await services.products.ensureMeasurementUnit('cx');
    expect(await db.getAllAsync<{ code: string; label: string }>(
      "SELECT code, label FROM measurement_units WHERE code = 'CX'"
    )).toEqual([{ code: 'CX', label: 'CX' }]);
  });
});
