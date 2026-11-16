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

let wish: Awaited<ReturnType<typeof makeCtx>>['services']['wishlist'];
let db: Awaited<ReturnType<typeof makeCtx>>['db'];

type ProjCls = WishlistProjectionMonth['classes'][number];
const findCls = (m: WishlistProjectionMonth, cls: ProjCls['cls']) => m.classes.find((c: ProjCls) => c.cls === cls)!;

beforeEach(async () => {
  const ctx = await makeCtx();
  wish = ctx.services.wishlist;
  db = ctx.db;
});

describe('v90 — WishlistService.getProjection (mensal, cascata com carryover)', () => {
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

  test('sobra do mês corrente COM capacidade grande: o que sobrar CAPACITY carrega para o próximo mês (carryover real)', async () => {
    // capacity 60/mês, item 100k: v89 = ceil(100/60) = 2 meses (a sobra
    // inteira é consumida no mês 1, capacity 60 não ajuda). Com carryover
    // REAL (que aqui é zero, porque a capacidade foi GASTA toda na cascade
    // do mês 1), o comportamento é o mesmo: 2 meses. Este teste documenta
    // que a `capacity` de cada mês é o TETO, não a sobra cumulativa — o
    // carryover só vale quando a `capacity` NÃO é gasta toda.
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
});
