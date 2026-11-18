/**
 * v90 — Projeção MENSAL da Programação de Compra em cascata MÊS A MÊS.
 *
 * v90 (vs v89):
 *  - O SALDO PREVISTO REAL do fim de cada mês é usado (não mais a sobra do
 *    mês de referência repetida em todos os meses). Tudo que SOBRA de um
 *    mês carrega para o próximo (carryover) — uma sobra grande em dez/2026
 *    é USADA em dez e o restante segue para jan/2027.
 *  - A cascade é sempre respeitada na ordem: Prioridade → Necessário → Desejo.
 *  - Na modalidade POUPANÇA "Fechamento do Mês" (a partir de `closingSince`)
 *    o carryover zera — a sobra positiva vai pra poupança e não acumula.
 *
 * Os testes usam DATAS RELATIVAS (`addDays / monthAdd`) — datas fixas
 * quebraram quando o calendário mudou (mantido desde v72).
 */
import { makeCtx, seedAccount } from '../helpers';
import { todaySP, monthAdd, monthOf } from '../../lib/dates';
import type {
  WishlistProjectionMonth,
  WishlistProjectionFetcher,
} from '../../services/WishlistService';
import { projectionMonthPlan } from '../../services/WishlistService';

let wish: Awaited<ReturnType<typeof makeCtx>>['services']['wishlist'];
let db: Awaited<ReturnType<typeof makeCtx>>['db'];

type ProjCls = WishlistProjectionMonth['classes'][number];
const findCls = (m: WishlistProjectionMonth, cls: ProjCls['cls']) => m.classes.find((c: ProjCls) => c.cls === cls)!;

beforeEach(async () => {
  const ctx = await makeCtx();
  wish = ctx.services.wishlist;
  db = ctx.db;
});

describe('v90/v95 — WishlistService.getProjection (mensal, cascata sem carryover de disponibilidade)', () => {
  test('cascade mês a mês usa o saldo real do fetcher por mês', async () => {
    // Cenário EXATO do relato do usuário: dez/2026 tem saldo suficiente
    // (R$ 30k), P custa R$ 4k. Hoje não tem capacidade (mês atual zerado),
    // dez compra tudo de P (30k abate 4k; sobraria 26k em "purchase
    // power" mas o item zerou), e nada segue para jan.
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'Notebook', targetCents: 4_000 });
    const hoje = todaySP();
    const startMonth = monthOf(hoje);
    const proxMonth = monthAdd(startMonth, 1);
    const fetcher: WishlistProjectionFetcher = async (m) => ({
      saldoPrevistoFimCents: m === startMonth ? 0 : 30_000,
      budgetSummary: null,
      savingsOverview: null,
    });
    const proj = await wish.getProjection(proxMonth, { fetcher });

    expect(proj.capacityCents).toBe(0); // mês atual: sem capacidade
    const mAtual = proj.months[0];
    expect(mAtual.month).toBe(startMonth);
    expect(mAtual.contributionCents).toBe(0);
    expect(findCls(mAtual, 'PRIORIDADE').abatidoCents).toBe(0);
    // dez: abatido 4_000 (custo do item); falta fim 0
    expect(proj.months.length).toBeGreaterThanOrEqual(2);
    const mDez = proj.months[1];
    expect(mDez.month).toBe(proxMonth);
    expect(findCls(mDez, 'PRIORIDADE').abatidoCents).toBe(4_000);
    expect(findCls(mDez, 'PRIORIDADE').faltaFimCents).toBe(0);
    expect(mDez.contributionCents).toBe(4_000);
    expect(proj.done).toBe(true);
    expect(proj.monthsUntilDone).toBe(2);
  });

  test('capacidade de cada mês é o TETO: NÃO carrega saldo não usado entre meses (v95)', async () => {
    // v95: cada mês usa SÓ a própria disponibilidade. O que SOBRA de
    // dinheiro NO MÊS NÃO carrega para o mês seguinte (o carryover de
    // capacidade só existia quando a lista inteira já tinha zerado — caso
    // em que não havia falta para abater, então era dead-code). A FALTA
    // é o único valor que segue adiante, dentro de `acc`.
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 100_000 });
    const fetcher: WishlistProjectionFetcher = async (_m) => ({
      saldoPrevistoFimCents: 60_000, budgetSummary: null, savingsOverview: null,
    });
    const proj = await wish.getProjection(monthOf(todaySP()), { fetcher });
    expect(proj.done).toBe(true);
    expect(proj.monthsUntilDone).toBe(2);
  });

  test('capacidade 0 em todos os meses → projection aborta (monthsUntilDone null)', async () => {
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 100_000 });
    const fetcher: WishlistProjectionFetcher = async (_m) => ({
      saldoPrevistoFimCents: 0, budgetSummary: null, savingsOverview: null,
    });
    const proj = await wish.getProjection(monthOf(todaySP()), { fetcher });

    expect(proj.capacityCents).toBe(0);
    expect(proj.done).toBe(false);
    expect(proj.monthsUntilDone).toBeNull();
    const m0 = proj.months[0];
    expect(m0.contributionCents).toBe(0);
    expect(findCls(m0, 'PRIORIDADE').abatidoCents).toBe(0);
    expect(findCls(m0, 'PRIORIDADE').faltaFimCents).toBe(100_000);
  });

  test('cascade em 3 classes em 3 meses consecutivos (P/N/D 50k, saldo 50k/mês)', async () => {
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 50_000 });
    await wish.addItem({ classificacao: 'NECESSARIO', description: 'N', targetCents: 50_000 });
    await wish.addItem({ classificacao: 'DESEJO', description: 'D', targetCents: 50_000 });
    const hoje = todaySP();
    const startMonth = monthOf(hoje);
    const fetcher: WishlistProjectionFetcher = async (_m) => ({
      saldoPrevistoFimCents: 50_000, budgetSummary: null, savingsOverview: null,
    });
    const proj = await wish.getProjection(monthAdd(startMonth, 2), { fetcher });

    expect(proj.done).toBe(true);
    expect(proj.monthsUntilDone).toBe(3);
    // mês 1: PRIORIDADE 50k → 0; N e D intactos
    expect(findCls(proj.months[0], 'PRIORIDADE').abatidoCents).toBe(50_000);
    expect(findCls(proj.months[0], 'NECESSARIO').abatidoCents).toBe(0);
    expect(findCls(proj.months[0], 'DESEJO').abatidoCents).toBe(0);
    // mês 2: NECESSARIO 50k → 0; PRIORIDADE continua 0; DESEJO intacto
    expect(findCls(proj.months[1], 'PRIORIDADE').abatidoCents).toBe(0);
    expect(findCls(proj.months[1], 'NECESSARIO').abatidoCents).toBe(50_000);
    expect(findCls(proj.months[1], 'DESEJO').abatidoCents).toBe(0);
    // mês 3: DESEJO 50k → 0
    expect(findCls(proj.months[2], 'DESEJO').abatidoCents).toBe(50_000);
    expect(proj.months[3]).toBeUndefined();
  });

  test('nova Prioridade cadastrada durante a fase de NECESSARIO → a ordem passa a respeitar P de novo', async () => {
    // Cenário do relato: "se não tiver Prioridade no mês e estiver na vida
    // de abatimento do NECESSARIO ou DESEJO e criar uma nova Prioridade a
    // ordem de prioridade de abatimento deve ser respeitada, sempre".
    // Aqui só validamos que getProjection sempre lê o estado atual: com N
    // já em fase, adicionar P e rodar de novo respeita P primeiro.
    await wish.addItem({ classificacao: 'NECESSARIO', description: 'N', targetCents: 100_000 });
    await wish.addItem({ classificacao: 'DESEJO', description: 'D', targetCents: 100_000 });
    // 1ª projeção: sem P → N começa a ser abatido.
    const fetcher: WishlistProjectionFetcher = async (_m) => ({
      saldoPrevistoFimCents: 60_000, budgetSummary: null, savingsOverview: null,
    });
    const projSemP = await wish.getProjection(monthAdd(monthOf(todaySP()), 1), { fetcher });
    expect(findCls(projSemP.months[0], 'NECESSARIO').abatidoCents).toBe(60_000);

    // Cadastra P 60k depois.
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 60_000 });
    const projComP = await wish.getProjection(monthAdd(monthOf(todaySP()), 1), { fetcher });
    // P passa pra frente: nova simulação começa abatendo P primeiro.
    expect(findCls(projComP.months[0], 'PRIORIDADE').abatidoCents).toBe(60_000);
    expect(findCls(projComP.months[0], 'NECESSARIO').abatidoCents).toBe(0);
  });

  test('saldoPrevistoAjustadoFimCents (override do Fluxo) vale só para o PRIMEIRO mês', async () => {
    // Compat v89: a tela do Fluxo passa o saldo AJUSTADO do mês corrente
    // (inclui budAdj + savAdj). Esse override é usado como SALDO do 1º mês.
    // Mês 2+ vem do fetcher (no app real, do BalanceService).
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 50_000 });
    const hoje = todaySP();
    const startMonth = monthOf(hoje);
    const proxMonth = monthAdd(startMonth, 1);
    const fetcher: WishlistProjectionFetcher = async (m) => ({
      saldoPrevistoFimCents: m === startMonth ? 0 : 30_000,
      budgetSummary: null,
      savingsOverview: null,
    });
    const proj = await wish.getProjection(proxMonth, {
      saldoPrevistoAjustadoFimCents: 50_000,
      fetcher,
    });
    expect(proj.capacityCents).toBe(50_000); // valor do override
    expect(findCls(proj.months[0], 'PRIORIDADE').abatidoCents).toBe(50_000);
    expect(findCls(proj.months[1], 'PRIORIDADE').abatidoCents).toBe(0);
  });

  test('reserva de valor ABAIXA a falta do item (a capacidade vem do dual.previsto, que já sente a transferência)', async () => {
    // Após reservar R$250 de um item de R$1.000, a FALTA que entra na cascade
    // é 750 (a reserva não conta de novo). A CAPACIDADE do mês é o saldo
    // previsto do fim — que, depois da reserva ser uma transferência REAL,
    // já saiu do saldo (dual.previsto já sente). A cascade segue como antes.
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 100_000 });
    const hoje = todaySP();
    const proxMonth = monthAdd(monthOf(hoje), 1);
    const fetcher50: WishlistProjectionFetcher = async (_m) => ({
      saldoPrevistoFimCents: 50_000, budgetSummary: null, savingsOverview: null,
    });
    const projSem = await wish.getProjection(proxMonth, { fetcher: fetcher50 });
    expect(findCls(projSem.months[0], 'PRIORIDADE').faltaInicioCents).toBe(100_000);
    expect(projSem.monthsUntilDone).toBe(2);

    // (a) conta origem com saldo; (b) reserva via API; (c) re-projeta.
    const acc = await seedAccount(db, 'Origem', 100_000);
    const itemId = (await wish.listOpen())[0]!.items[0]!.id;
    await wish.reserve({
      itemId,
      amountCents: 25_000,
      fromAccountId: acc,
      destination: { kind: 'BOX' },
    });
    const projCom = await wish.getProjection(proxMonth, { fetcher: fetcher50 });
    // FALTA começa em 75_000 (= 100_000 − 25_000).
    expect(findCls(projCom.months[0], 'PRIORIDADE').faltaInicioCents).toBe(75_000);
    // 75k / 50k = 2 meses (mesma quantidade — a reserva só baixou o item).
    expect(projCom.monthsUntilDone).toBe(2);
  });

  // ---- v95 (regra do usuário) ----

  test('Ex1 — lista CABE inteira na disponibilidade do mês: mata tudo e NÃO repete no próximo', async () => {
    // Disponibilidade 1.000 em ambos os meses; lista total 900 (P 600 + N 200 + D 100)
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 60_000 });
    await wish.addItem({ classificacao: 'NECESSARIO', description: 'N', targetCents: 20_000 });
    await wish.addItem({ classificacao: 'DESEJO', description: 'D', targetCents: 10_000 });
    const hoje = todaySP();
    const startMonth = monthOf(hoje);
    const proxMonth = monthAdd(startMonth, 1);
    const fetcher: WishlistProjectionFetcher = async () => ({
      saldoPrevistoFimCents: 100_000, budgetSummary: null, savingsOverview: null,
    });
    const proj = await wish.getProjection(proxMonth, { fetcher });
    const m1 = proj.months.find((x) => x.month === startMonth)!;
    const m2 = proj.months.find((x) => x.month === proxMonth)!;
    // mês atual: abate TUDO (P+N+D = 90k, < 100k)
    expect(m1.contributionCents).toBe(90_000);
    expect(findCls(m1, 'PRIORIDADE').abatidoCents).toBe(60_000);
    expect(findCls(m1, 'NECESSARIO').abatidoCents).toBe(20_000);
    expect(findCls(m1, 'DESEJO').abatidoCents).toBe(10_000);
    expect(findCls(m1, 'DESEJO').faltaFimCents).toBe(0);
    // mês seguinte: capacidade alta, mas falta = 0 → ZERA — não reflete
    expect(m2.contributionCents).toBe(0);
    expect(findCls(m2, 'PRIORIDADE').abatidoCents).toBe(0);
    expect(findCls(m2, 'NECESSARIO').abatidoCents).toBe(0);
    expect(findCls(m2, 'DESEJO').abatidoCents).toBe(0);
    expect(proj.done).toBe(true);
    // nada entrou no mês seguinte (a previsão só vale para o mês planejado)
    expect(m2.classes.reduce((a, c) => a + c.faltaInicioCents, 0)).toBe(0);
  });

  test('Ex2 — lista EXCEDE a disponibilidade: abate só P no mês atual e continua P → N → D no mês seguinte', async () => {
    // Disponibilidade 1.000 / mês; lista total 2.000 (P 1.200 + N 500 + D 300)
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 120_000 });
    await wish.addItem({ classificacao: 'NECESSARIO', description: 'N', targetCents: 50_000 });
    await wish.addItem({ classificacao: 'DESEJO', description: 'D', targetCents: 30_000 });
    const hoje = todaySP();
    const startMonth = monthOf(hoje);
    const proxMonth = monthAdd(startMonth, 1);
    const fetcher: WishlistProjectionFetcher = async () => ({
      saldoPrevistoFimCents: 100_000, budgetSummary: null, savingsOverview: null,
    });
    const proj = await wish.getProjection(proxMonth, { fetcher });
    const m1 = proj.months.find((x) => x.month === startMonth)!;
    const m2 = proj.months.find((x) => x.month === proxMonth)!;
    // mês atual: 100k abate só Prioridade (1.200 → sobra 200); N e D
    // nem começam este mês.
    expect(m1.contributionCents).toBe(100_000);
    expect(findCls(m1, 'PRIORIDADE').abatidoCents).toBe(100_000);
    expect(findCls(m1, 'PRIORIDADE').faltaFimCents).toBe(20_000);
    expect(findCls(m1, 'NECESSARIO').abatidoCents).toBe(0);
    expect(findCls(m1, 'DESEJO').abatidoCents).toBe(0);
    // mês seguinte: 100k abate o RESTO de P (200) + N inteiro (500) + D inteiro (300)
    expect(m2.contributionCents).toBe(100_000);
    expect(findCls(m2, 'PRIORIDADE').abatidoCents).toBe(20_000);
    expect(findCls(m2, 'NECESSARIO').abatidoCents).toBe(50_000);
    expect(findCls(m2, 'DESEJO').abatidoCents).toBe(30_000);
    expect(findCls(m2, 'DESEJO').faltaFimCents).toBe(0);
    expect(proj.done).toBe(true);
    // M2 só entrou com a parcela que sobrou (200 P + 500 N + 300 D = 1.000)
    expect(m2.classes.reduce((a, c) => a + c.faltaInicioCents, 0)).toBe(100_000);
  });

  test('plano quitado no mês atual: próxima projeção vem com contribución 0 mesmo sobrando saldo', async () => {
    // v95: NÃO se reflete automaticamente. Mês 1 quita tudo; mês 2 mesmo
    // com 100k de saldo nada é abatido (a previsão não vale para outros
    // meses).
    await wish.addItem({ classificacao: 'NECESSARIO', description: 'N', targetCents: 90_000 });
    const hoje = todaySP();
    const startMonth = monthOf(hoje);
    const proxMonth = monthAdd(startMonth, 1);
    const fetcher: WishlistProjectionFetcher = async () => ({
      saldoPrevistoFimCents: 100_000, budgetSummary: null, savingsOverview: null,
    });
    const proj = await wish.getProjection(proxMonth, { fetcher });
    const m1 = proj.months.find((x) => x.month === startMonth)!;
    const m2 = proj.months.find((x) => x.month === proxMonth)!;
    expect(m1.contributionCents).toBe(90_000);
    expect(findCls(m1, 'NECESSARIO').faltaFimCents).toBe(0);
    // Mês seguinte: 100k sobrando, mas falta 0 → ZERA.
    expect(m2.contributionCents).toBe(0);
    expect(findCls(m2, 'NECESSARIO').abatidoCents).toBe(0);
    expect(m2.classes.reduce((a, c) => a + c.faltaInicioCents, 0)).toBe(0);
  });
});

describe('v95 — projectionMonthPlan (plano de UM mês para o card fixo do Fluxo)', () => {
  test('mês presente na projeção: planoCents = abatido; faltaInicio = o que entrou', async () => {
    // P 50 + D 20; mês atual 30k, próximo 50k
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 50_000 });
    await wish.addItem({ classificacao: 'DESEJO', description: 'D', targetCents: 20_000 });
    const hoje = todaySP();
    const startMonth = monthOf(hoje);
    const proxMonth = monthAdd(startMonth, 1);
    const fetcher: WishlistProjectionFetcher = async (m) => ({
      saldoPrevistoFimCents: m === startMonth ? 30_000 : 50_000,
      budgetSummary: null, savingsOverview: null,
    });
    const proj = await wish.getProjection(proxMonth, { fetcher });

    const plan1 = projectionMonthPlan(proj, startMonth);
    expect(plan1.planoCents).toBe(30_000); // só P 30k
    expect(plan1.faltaInicioCents).toBe(70_000); // 50 P + 20 D
    expect(plan1.classes.map((c) => c.cls)).toEqual(['PRIORIDADE', 'NECESSARIO', 'DESEJO']);

    const plan2 = projectionMonthPlan(proj, proxMonth);
    expect(plan2.planoCents).toBe(40_000); // P 20k + D 20k
    expect(plan2.faltaInicioCents).toBe(40_000); // 20 P + 20 D que sobraram
  });

  test('mês AUSENTE (passado ou após quitação): zeros — a previsão não vale para outros meses', async () => {
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 50_000 });
    const hoje = todaySP();
    const startMonth = monthOf(hoje);
    const tresAtras = monthAdd(startMonth, -3);
    const fetcher: WishlistProjectionFetcher = async () => ({
      saldoPrevistoFimCents: 100_000, budgetSummary: null, savingsOverview: null,
    });
    // Projeta só até o mês corrente → o passado (3 meses antes) não está.
    const proj = await wish.getProjection(startMonth, { fetcher });
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
