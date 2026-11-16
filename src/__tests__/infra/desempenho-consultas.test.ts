/**
 * v86 — DESEMPENHO: consultas por MÊS (faixa indexável), índices da migração
 * v55, previsão das fixas em LOTE e o "começar do zero".
 *
 * O que esta bateria protege (nada aqui muda regra de negócio — só QUANTAS
 * vezes e COM QUE FILTRO o banco é consultado):
 *  1. `monthRange` — faixa [início, início do mês seguinte) para substituir
 *     `substr(coluna,1,7) = ?` / `coluna LIKE 'AAAAMM%'`, que impedem o uso de
 *     índice (full scan na tabela inteira). Vira o ano corretamente (dez→jan).
 *  2. ÍNDICES criados pela migração v55 existem no banco migrado.
 *  3. Filtro por faixa não perde o dia 1 nem o último dia do mês e não deixa
 *     entrar lançamento do mês seguinte.
 *  4. `runForecast` em lote: cria a previsão de todos os meses em UMA passada
 *     e continua IDEMPOTENTE (rodar de novo não duplica nada).
 *  5. `resetUserData` ("Começar do zero agora"): apaga os dados e RECOLOCA as
 *     categorias padrão — sem isso o app abriria sem categoria nenhuma.
 *  6. Preferência `zerarAoAbrir`: o padrão é DESLIGADO (os dados persistem
 *     entre aberturas). Era o comportamento pedido na v86.
 */

import { makeCtx, seedAccount, type TestCtx } from '../helpers';
import { monthRange } from '../../lib/dates';
import { buildGroupMonths, type FlowTx } from '../../lib/flowModel';
import { resetUserData } from '../../db/seed';
import { SETTING_KEYS } from '../../services/SettingsService';

let ctx: TestCtx;

beforeEach(async () => {
  ctx = await makeCtx();
});

describe('v86 · 1 — monthRange (faixa indexável no lugar de substr/LIKE)', () => {
  test('mês normal: início do mês e início do mês seguinte (fim EXCLUSIVO)', () => {
    expect(monthRange('2026-11')).toEqual({ start: '2026-11-01', end: '2026-12-01' });
  });

  test('dezembro vira o ano', () => {
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', end: '2027-01-01' });
  });

  test('fevereiro de ano bissexto é fevereiro inteiro', () => {
    expect(monthRange('2024-02')).toEqual({ start: '2024-02-01', end: '2024-03-01' });
  });
});

describe('v86 · 2 — índices da migração v55', () => {
  test('todos os índices de consulta por mês/grupo existem', async () => {
    const rows = await ctx.db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"
    );
    const names = rows.map((r) => r.name);
    for (const idx of [
      'idx_tx_occurred_on',
      'idx_tx_recurrence_date',
      'idx_fm_effective_date',
      'idx_inv_due_date',
      'idx_inst_due_date',
      'idx_rules_group',
      'idx_plans_group',
    ]) {
      expect(names).toContain(idx);
    }
  });
});

describe('v86 · 3 — filtro por faixa cobre o mês inteiro', () => {
  test('listFlow: pega dia 1 e último dia, ignora o mês seguinte', async () => {
    const acc = await seedAccount(ctx.db, 'Faixa', 100_000);
    for (const date of ['2026-11-01', '2026-11-30', '2026-12-01']) {
      await ctx.services.transactions.createAccountExpense({
        description: `Tx ${date}`,
        amountCents: 1_000,
        date,
        accountId: acc,
      });
    }
    const rows = (await ctx.services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    const dates = rows.map((r) => r.occurred_on).sort();
    expect(dates).toEqual(['2026-11-01', '2026-11-30']);
  });

  test('getLastActivityDate: usa o último dia do mês e não vaza para o seguinte', async () => {
    const acc = await seedAccount(ctx.db, 'Ultima', 100_000);
    await ctx.services.transactions.createAccountExpense({
      description: 'Dia 15', amountCents: 500, date: '2026-11-15', accountId: acc,
    });
    await ctx.services.transactions.createAccountExpense({
      description: 'Dezembro', amountCents: 500, date: '2026-12-05', accountId: acc,
    });
    expect(await ctx.services.balance.getLastActivityDate('2026-11')).toBe('2026-11-15');
  });
});

describe('v86 · 4 — previsão das fixas em LOTE', () => {
  test('cria todos os meses numa passada e continua idempotente', async () => {
    const acc = await seedAccount(ctx.db, 'Lote', 0);
    await ctx.services.recurrences.createRule({
      description: 'Aluguel',
      type: 'EXPENSE',
      amountCents: 120_000,
      dayOfMonth: 10,
      startDate: '2026-11-10',
      accountId: acc,
    });

    const first = await ctx.services.recurrences.runForecast(12, '2026-11-02');
    expect(first.createdForecast).toBeGreaterThan(0);

    // Rodar de novo NÃO duplica (mesma chave REC:{ruleId}:{AAAA-MM})
    const second = await ctx.services.recurrences.runForecast(12, '2026-11-02');
    expect(second.createdForecast).toBe(0);

    const rows = await ctx.db.getAllAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE source_system = 'RECURRENCE' AND external_ref_id LIKE 'REC:%'"
    );
    expect(rows[0].n).toBe(first.createdForecast);
  });

  test('previsão é PENDING e não mexe no saldo', async () => {
    const acc = await seedAccount(ctx.db, 'SemSaldo', 50_000);
    await ctx.services.recurrences.createRule({
      description: 'Internet',
      type: 'EXPENSE',
      amountCents: 9_990,
      dayOfMonth: 20,
      startDate: '2026-11-20',
      accountId: acc,
    });
    await ctx.services.recurrences.runForecast(6, '2026-11-02');
    expect(await ctx.services.balance.getAccountBalance(acc)).toBe(50_000);
    const move = await ctx.db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM financial_moves fm JOIN transactions t ON t.id = fm.transaction_id WHERE t.source_system = 'RECURRENCE'"
    );
    expect(move?.n).toBe(0);
  });
});

describe('v86 · 5 — grupos consolidados em lote (buildGroupMonths)', () => {
  test('devolve o grupo com cabeçalho no mês e a ocorrência da fixa vinculada', async () => {
    const acc = await seedAccount(ctx.db, 'Grupo', 100_000);
    // Grupo consolidado (cabeçalho) + conta fixa vinculada — o caminho do
    // formulário "Consolidado > Fixo".
    const grupo = await ctx.services.transactions.createConsolidatedGroup({
      description: 'Assinaturas',
      date: '2026-11-05',
      accountId: acc,
      lines: [],
      headerAmountCents: 5_000,
      headerType: 'EXPENSE',
    });
    expect(grupo).not.toBeNull();
    await ctx.services.recurrences.createRule({
      description: 'Streaming',
      type: 'EXPENSE',
      amountCents: 2_000,
      dayOfMonth: 12,
      startDate: '2026-11-01',
      accountId: acc,
      groupTransactionId: grupo!.id,
    });
    await ctx.services.recurrences.runForecast(3, '2026-11-02');

    const rows = (await ctx.services.transactions.listFlow('2026-11')) as unknown as FlowTx[];
    const { gm, occIds } = await buildGroupMonths(ctx.db, '2026-11', rows);
    expect(Object.keys(gm)).toContain(grupo!.id);
    expect(gm[grupo!.id].isHeaderMonth).toBe(true);
    expect(gm[grupo!.id].occurrences.length).toBe(1);
    expect(occIds.size).toBe(1);
    expect(rows.some((r) => occIds.has(r.id))).toBe(true);
  });
});

describe('v88 · 6 — começar do zero (dados persistem; sem categorias padrão)', () => {
  test('a preferência "zerarAoAbrir" foi REMOVIDA (não existe mais a chave)', async () => {
    // v88: o toggle "Começar do zero a cada abertura" saiu do app — a limpeza
    // do arranque não existe mais. O dado antigo (se sobrou na base) é
    // ignorado.
    const chave = 'zerar_ao_abrir';
    const linhas = await ctx.db.getAllAsync<{ key: string }>(
      'SELECT key FROM app_settings WHERE key = ?',
      [chave]
    );
    expect(linhas.length).toBe(0);
  });

  test('resetUserData apaga conta/lançamento e NÃO recria categorias', async () => {
    const acc = await seedAccount(ctx.db, 'Some', 100_000);
    await ctx.services.transactions.createAccountExpense({
      description: 'Compra', amountCents: 1_000, date: '2026-11-10', accountId: acc,
    });
    // uma categoria do usuário (não do seed) para provar que ela também some
    // (o "começar do zero" apaga TUDO)
    await ctx.services.categories.create({ name: 'Minha', direction: 'DEBIT' });

    await resetUserData(ctx.db);

    const accounts = await ctx.db.getAllAsync<{ n: number }>('SELECT COUNT(*) AS n FROM accounts');
    expect(accounts[0].n).toBe(0);
    const txs = await ctx.db.getAllAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txs[0].n).toBe(0);
    // v88: o app NÃO cria categoria nenhuma sozinho (nem as do seed antigo)
    const cats = await ctx.db.getAllAsync<{ name: string }>('SELECT name FROM categories ORDER BY name');
    expect(cats.length).toBe(0);
  });
});
