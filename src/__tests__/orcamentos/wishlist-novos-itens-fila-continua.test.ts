/**
 * v27 — Programação de Compra: nova compra cadastrada durante os meses
 * REORDENA a fila e a fila NÃO recomeça nos meses futuros.
 *
 * Cenário do usuário (Nov/2026): P 5.000 + N 3.000 + D 2.000 com
 * disponibilidade de 2.500/mês. Ao avançar os meses o cálculo fechava
 * corretamente (P → N → D). Mas quando "nasce" uma nova Prioridade e um
 * novo Necessário, ao avançar os meses a fila REINICIAVA do zero:
 *
 *  · BUG: um item cuja falta zera num mês futuro não entra na cascade
 *    daquele mês (`faltaInicio <= 0 → continue`) e fica SEM linha em
 *    `month_ledger_wishlist`. No mês seguinte, `carry == undefined` caía no
 *    fallback `fresh` (target − reserved): o item quitado na simulação
 *    RESSUSCITAVA com a falta inteira (P voltava a 9.000 em abr/2027),
 *    empurrando Necessário/Desejo para trás — o plano nunca chegava a done.
 *
 *  · FIX (MonthLedgerService.cascadeWishlistForMonth): nos meses futuros,
 *    carry AUSENTE = 0 (o item já saiu da fila). A falta fresca só vale
 *    para o mês corrente (estado real de hoje).
 */
import { makeCtx, seedAccount } from '../helpers';
import { todaySP, monthAdd, monthOf } from '../../lib/dates';
import { SETTING_KEYS } from '../../services/SettingsService';
import type { WishlistProjectionMonth } from '../../services/WishlistService';

let wish: Awaited<ReturnType<typeof makeCtx>>['services']['wishlist'];
let db: Awaited<ReturnType<typeof makeCtx>>['db'];
let ctxServices: Awaited<ReturnType<typeof makeCtx>>['services'];

type ProjCls = WishlistProjectionMonth['classes'][number];
const findCls = (m: WishlistProjectionMonth, cls: ProjCls['cls']) =>
  m.classes.find((c: ProjCls) => c.cls === cls)!;

beforeEach(async () => {
  const ctx = await makeCtx();
  wish = ctx.services.wishlist;
  db = ctx.db;
  ctxServices = ctx.services;
  // A cascade só aloca com a Programação de Compra ativa.
  await ctx.services.settings.setBool(SETTING_KEYS.wishlistNaHome, true);
});

test('v27 — nova P e novo N cadastrados: reordena e a fila segue até o fim sem recomeçar', async () => {
  const acc = await seedAccount(db, 'Corrente', 250_000);
  const startMonth = monthOf(todaySP()); // mês corrente (ex.: 2026-11)
  const proxMonth = monthAdd(startMonth, 1);

  // Renda recorrente de 2.500/mês a partir do mês seguinte — capacidade
  // mensal constante para a simulação.
  await ctxServices.recurrences.createRule({
    description: 'Salário', type: 'INCOME', amountCents: 250_000,
    dayOfMonth: 1, startDate: `${proxMonth}-01`, accountId: acc,
  });
  await ctxServices.recurrences.ensureForecastThrough(monthAdd(startMonth, 8));

  // Fila original: P1 5.000 + N1 3.000 + D1 2.000, 2.500/mês.
  await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P1', targetCents: 500_000 });
  await wish.addItem({ classificacao: 'NECESSARIO', description: 'N1', targetCents: 300_000 });
  await wish.addItem({ classificacao: 'DESEJO', description: 'D1', targetCents: 200_000 });

  // Baseline: a fila original fecha em 4 meses (2 de P, 1 de N, D junto ao N).
  const projAntes = await wish.getProjection(monthAdd(startMonth, 4));
  expect(findCls(projAntes.months[0], 'PRIORIDADE').abatidoCents).toBe(250_000);
  expect(findCls(projAntes.months[0], 'NECESSARIO').abatidoCents).toBe(0);
  expect(projAntes.monthsUntilDone).toBe(4);

  // ===== "Nasce" uma nova Prioridade (4.000) e um novo Necessário (3.000) =====
  await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P2-novo', targetCents: 400_000 });
  await wish.addItem({ classificacao: 'NECESSARIO', description: 'N2-novo', targetCents: 300_000 });

  const proj = await wish.getProjection(monthAdd(startMonth, 8));
  const m0 = proj.months[0];
  const m1 = proj.months[1];

  // Reordenação: a classe Prioridade (agora 9.000) consome TODA a
  // capacidade nos primeiros meses; Necessário (agora 6.000) e Desejo
  // nem começam.
  expect(findCls(m0, 'PRIORIDADE').faltaInicioCents).toBe(900_000);
  expect(findCls(m0, 'PRIORIDADE').abatidoCents).toBe(250_000);
  expect(findCls(m0, 'NECESSARIO').abatidoCents).toBe(0);
  expect(findCls(m0, 'DESEJO').abatidoCents).toBe(0);
  expect(findCls(m1, 'PRIORIDADE').abatidoCents).toBe(250_000);
  expect(findCls(m1, 'NECESSARIO').abatidoCents).toBe(0);

  // Continuidade: após a Prioridade fechar (mês 4), a fila segue NECESSÁRIO
  // e DESEJO — a Prioridade NÃO volta com a falta fresca (bug era
  // PRIORIDADE ini=900_000 de novo no mês 6).
  const prio = proj.months.map((m) => findCls(m, 'PRIORIDADE'));
  const ultimoMesComPrio = prio.reduce(
    (acc, c, i) => (c.faltaInicioCents > 0 ? i : acc), -1
  );
  // P 9.000 / 2.500 → ocupa os meses 1-4 (índice 3) na simulação de 9 meses.
  expect(ultimoMesComPrio).toBe(3);
  // Depois que a Prioridade fecha, NENHUM mês futuro volta a mostrá-la.
  for (let i = ultimoMesComPrio + 1; i < proj.months.length; i++) {
    expect(findCls(proj.months[i], 'PRIORIDADE').faltaInicioCents).toBe(0);
    expect(findCls(proj.months[i], 'PRIORIDADE').abatidoCents).toBe(0);
  }

  // A fila termina de verdade: Necessário (6.000) começa no mês 4 (restante
  // da capacidade de Prioridade) e fecha; Desejo (2.000) fecha em seguida —
  // total 7 meses, e os meses seguintes ficam zerados (sem recomeço).
  expect(proj.monthsUntilDone).toBe(7);
  expect(proj.done).toBe(true);
  const mesDepoisDoFim = proj.months[7];
  expect(mesDepoisDoFim.contributionCents).toBe(0);
  expect(mesDepoisDoFim.classes.reduce((a, c) => a + c.faltaInicioCents, 0)).toBe(0);
});

test('v27 — item quitado nos meses futuros não ressuscita mesmo com reserva parcial real', async () => {
  const acc = await seedAccount(db, 'Corrente', 250_000);
  const startMonth = monthOf(todaySP());
  const proxMonth = monthAdd(startMonth, 1);
  await ctxServices.recurrences.createRule({
    description: 'Salário', type: 'INCOME', amountCents: 250_000,
    dayOfMonth: 1, startDate: `${proxMonth}-01`, accountId: acc,
  });
  await ctxServices.recurrences.ensureForecastThrough(monthAdd(startMonth, 5));

  // P 5.000 fecha em 2 meses; N 3.000 no 3º; D 2.000 fecha no 4º.
  await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P1', targetCents: 500_000 });
  await wish.addItem({ classificacao: 'NECESSARIO', description: 'N1', targetCents: 300_000 });
  await wish.addItem({ classificacao: 'DESEJO', description: 'D1', targetCents: 200_000 });

  const proj = await wish.getProjection(monthAdd(startMonth, 5));
  expect(proj.monthsUntilDone).toBe(4);
  // Nenhum mês além do fim volta a mostrar qualquer falta (a fila não
  // recomeça depois de concluída).
  const fimIdx = proj.monthsUntilDone! - 1;
  for (let i = fimIdx + 1; i < proj.months.length; i++) {
    expect(proj.months[i].classes.reduce((a, c) => a + c.faltaInicioCents, 0)).toBe(0);
  }
});
