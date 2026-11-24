/**
 * v100/v17 — Projeção MENSAL da Programação de Compra lendo a cascade
 * PERSISTIDA no livro-razão (month_ledger_wishlist).
 *
 * O `fetcher` injetado saiu do getProjection (sobrou só como compat de
 * tipos): a fonte única é o livro-razão, que encadeia mês a mês a partir do
 * saldo REAL das contas. Os cenários agora semeiam contas de verdade.
 * Datas RELATIVAS (monthOf(todaySP())) — datas fixas quebraram quando o
 * calendário mudou (mantido desde v72).
 */
import { makeCtx, seedAccount } from '../helpers';
import { todaySP, monthAdd, monthOf } from '../../lib/dates';
import { SETTING_KEYS } from '../../services/SettingsService';
import type { WishlistProjectionMonth } from '../../services/WishlistService';
import { projectionMonthPlan } from '../../services/WishlistService';

let wish: Awaited<ReturnType<typeof makeCtx>>['services']['wishlist'];
let db: Awaited<ReturnType<typeof makeCtx>>['db'];
let ctxServices: Awaited<ReturnType<typeof makeCtx>>['services'];

type ProjCls = WishlistProjectionMonth['classes'][number];
const findCls = (m: WishlistProjectionMonth, cls: ProjCls['cls']) => m.classes.find((c: ProjCls) => c.cls === cls)!;

beforeEach(async () => {
  const ctx = await makeCtx();
  wish = ctx.services.wishlist;
  db = ctx.db;
  ctxServices = ctx.services;
  // v17: a cascade só aloca com a Programação de Compra ativa
  // (computeMonth lê `wishlist_na_home`).
  await ctx.services.settings.setBool(SETTING_KEYS.wishlistNaHome, true);
});

describe('v100 — getProjection lê a cascade do livro-razão', () => {
  test('capacidade 0 (sem conta): projeção aborta (monthsUntilDone null)', async () => {
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 100_000 });
    const proj = await wish.getProjection(monthOf(todaySP()));
    expect(proj.capacityCents).toBe(0);
    expect(proj.done).toBe(false);
    expect(proj.monthsUntilDone).toBeNull();
    const m0 = proj.months[0];
    expect(m0.contributionCents).toBe(0);
    expect(findCls(m0, 'PRIORIDADE').abatidoCents).toBe(0);
    expect(findCls(m0, 'PRIORIDADE').faltaFimCents).toBe(100_000);
  });

  test('lista CABE inteira na disponibilidade: mata tudo no mês e NÃO repete no próximo', async () => {
    await seedAccount(db, 'Corrente', 100_000);
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 60_000 });
    await wish.addItem({ classificacao: 'NECESSARIO', description: 'N', targetCents: 20_000 });
    await wish.addItem({ classificacao: 'DESEJO', description: 'D', targetCents: 10_000 });
    const startMonth = monthOf(todaySP());
    const proxMonth = monthAdd(startMonth, 1);
    const proj = await wish.getProjection(proxMonth);
    const m1 = proj.months.find((x) => x.month === startMonth)!;
    const m2 = proj.months.find((x) => x.month === proxMonth)!;
    // mês atual: abate TUDO (P+N+D = 90k, < 100k de disponibilidade)
    expect(m1.contributionCents).toBe(90_000);
    expect(findCls(m1, 'PRIORIDADE').abatidoCents).toBe(60_000);
    expect(findCls(m1, 'NECESSARIO').abatidoCents).toBe(20_000);
    expect(findCls(m1, 'DESEJO').abatidoCents).toBe(10_000);
    expect(findCls(m1, 'DESEJO').faltaFimCents).toBe(0);
    // mês seguinte: a previsão NÃO vale para outros meses — zera
    expect(m2.contributionCents).toBe(0);
    expect(findCls(m2, 'PRIORIDADE').abatidoCents).toBe(0);
    expect(m2.classes.reduce((a, c) => a + c.faltaInicioCents, 0)).toBe(0);
    expect(proj.done).toBe(true);
  });

  test('lista EXCEDE a disponibilidade: abate só P agora e continua P → N → D no mês seguinte', async () => {
    const acc = await seedAccount(db, 'Corrente', 100_000);
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 120_000 });
    await wish.addItem({ classificacao: 'NECESSARIO', description: 'N', targetCents: 50_000 });
    await wish.addItem({ classificacao: 'DESEJO', description: 'D', targetCents: 30_000 });
    const startMonth = monthOf(todaySP());
    const proxMonth = monthAdd(startMonth, 1);
    // v17: a capacidade do mês seguinte é o saldo REAL dele — sem renda
    // recorrente o mês nasce zerado (o closing já descontou o abatido).
    // A fixa de salário garante a disponibilidade do mês seguinte.
    await ctxServices.recurrences.createRule({
      description: 'Salário', type: 'INCOME', amountCents: 100_000,
      dayOfMonth: 1, startDate: `${proxMonth}-01`, accountId: acc,
    });
    await ctxServices.recurrences.ensureForecastThrough(proxMonth);
    const proj = await wish.getProjection(proxMonth);
    const m1 = proj.months.find((x) => x.month === startMonth)!;
    const m2 = proj.months.find((x) => x.month === proxMonth)!;
    // mês atual: 100k abate só Prioridade (120k → falta 20k); N e D nem começam
    expect(m1.contributionCents).toBe(100_000);
    expect(findCls(m1, 'PRIORIDADE').abatidoCents).toBe(100_000);
    expect(findCls(m1, 'PRIORIDADE').faltaFimCents).toBe(20_000);
    expect(findCls(m1, 'NECESSARIO').abatidoCents).toBe(0);
    expect(findCls(m1, 'DESEJO').abatidoCents).toBe(0);
    // mês seguinte: 100k de salário abate o RESTO de P (20k) + N (50k) + D (30k)
    expect(m2.contributionCents).toBe(100_000);
    expect(findCls(m2, 'PRIORIDADE').abatidoCents).toBe(20_000);
    expect(findCls(m2, 'NECESSARIO').abatidoCents).toBe(50_000);
    expect(findCls(m2, 'DESEJO').abatidoCents).toBe(30_000);
    expect(findCls(m2, 'DESEJO').faltaFimCents).toBe(0);
    expect(proj.done).toBe(true);
    expect(proj.monthsUntilDone).toBe(2);
  });

  test('nova Prioridade cadastrada durante a fase de NECESSARIO → a ordem passa a respeitar P de novo', async () => {
    await seedAccount(db, 'Corrente', 60_000);
    await wish.addItem({ classificacao: 'NECESSARIO', description: 'N', targetCents: 100_000 });
    await wish.addItem({ classificacao: 'DESEJO', description: 'D', targetCents: 100_000 });
    const proxMonth = monthAdd(monthOf(todaySP()), 1);
    // 1ª projeção: sem P → N começa a ser abatido (60k de disponibilidade)
    const projSemP = await wish.getProjection(proxMonth);
    expect(findCls(projSemP.months[0], 'NECESSARIO').abatidoCents).toBe(60_000);
    // Cadastra P 60k depois: getProjection sempre lê o estado atual —
    // a nova simulação começa abatendo P primeiro.
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 60_000 });
    const projComP = await wish.getProjection(proxMonth);
    expect(findCls(projComP.months[0], 'PRIORIDADE').abatidoCents).toBe(60_000);
    expect(findCls(projComP.months[0], 'NECESSARIO').abatidoCents).toBe(0);
  });
});

describe('v95 — projectionMonthPlan (plano de UM mês para o card fixo do Fluxo)', () => {
  test('mês presente na projeção: planoCents = abatido; faltaInicio = o que entrou', async () => {
    const acc = await seedAccount(db, 'Corrente', 30_000);
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 50_000 });
    await wish.addItem({ classificacao: 'DESEJO', description: 'D', targetCents: 20_000 });
    const startMonth = monthOf(todaySP());
    const proxMonth = monthAdd(startMonth, 1);
    // renda fixa do mês seguinte: a capacidade lá é o saldo REAL (v17)
    await ctxServices.recurrences.createRule({
      description: 'Salário', type: 'INCOME', amountCents: 30_000,
      dayOfMonth: 1, startDate: `${proxMonth}-01`, accountId: acc,
    });
    await ctxServices.recurrences.ensureForecastThrough(proxMonth);
    const proj = await wish.getProjection(proxMonth);

    const plan1 = projectionMonthPlan(proj, startMonth);
    expect(plan1.planoCents).toBe(30_000); // só P 30k cabe nos 30k do mês
    expect(plan1.faltaInicioCents).toBe(70_000); // 50 P + 20 D
    expect(plan1.classes.map((c) => c.cls)).toEqual(['PRIORIDADE', 'NECESSARIO', 'DESEJO']);

    const plan2 = projectionMonthPlan(proj, proxMonth);
    expect(plan2.faltaInicioCents).toBe(40_000); // 20 P + 20 D que sobraram
    expect(plan2.planoCents).toBe(30_000); // cabe nos 30k de salário do mês
  });

  test('mês AUSENTE (passado ou após quitação): zeros — a previsão não vale para outros meses', async () => {
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 50_000 });
    const startMonth = monthOf(todaySP());
    const tresAtras = monthAdd(startMonth, -3);
    // Projeta só até o mês corrente → o passado (3 meses antes) não está.
    const proj = await wish.getProjection(startMonth);
    const planPassado = projectionMonthPlan(proj, tresAtras);
    expect(planPassado.planoCents).toBe(0);
    expect(planPassado.faltaInicioCents).toBe(0);
    expect(planPassado.classes).toEqual([]);
  });

  test('projectionMonthPlan(null, …): zeros (sem projeção carregada)', () => {
    const plan = projectionMonthPlan(null, monthOf(todaySP()));
    expect(plan.planoCents).toBe(0);
    expect(plan.faltaInicioCents).toBe(0);
    expect(plan.classes).toEqual([]);
  });
});
