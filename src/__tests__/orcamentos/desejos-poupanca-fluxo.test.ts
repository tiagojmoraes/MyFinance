/**
 * (v80) Parte de v69.test.ts — Lista de Desejos, metodologia, poupança do Fluxo e linha Orçado•Previsto•Gasto.
 * v69 — TESTES: mensagens bancárias, Lista de Desejos, poupança do Fluxo e
 * formato "Orçado • Previsto • Gasto".
 *
 * 1. PARSER de mensagens (débito/crédito, valor pt-BR, data, estabelecimento);
 * 2. INGEST na lista — idempotente, NUNCA cria lançamento sozinho;
 * 3. "Lançar" + CONCILIAÇÃO OFX automática por data + valor (nos DOIS sentidos:
 *    OFX já importado → vincula na hora; OFX depois → casamento padrão);
 * 4. "Deletar" tira da lista;
 * 5. LISTA DE DESEJOS — cadastro/alteração/exclusão, reserva na CAIXINHA fora
 *    do saldo geral, reserva na POUPANÇA em fatia separada, barra 100% = pronto,
 *    comprar vira lançamento normal;
 * 6. METODOLOGIA (5.2) — sobra 1.500 x Prioridade 3.000 → 2 meses; as outras
 *    classificações nem começam; frases pedidas pelo usuário;
 * 7. POUPANÇA do Fluxo — cabeçalho não fica em R$ 0,00 (programado inclui a
 *    estimativa do Fechamento), "Falta transferir" = programado − transferido;
 * 8. FORMATO da linha "Orçado • Previsto • Gasto" — uma linha, % redonda.
 */

import { makeCtx, seedAccount, seedCategory, expectRejects, type TestCtx } from '../helpers';
import {
  BankMessageService, parseBankMessage, parseValorTexto,
} from '../../services/BankMessageService';
import {
  WishlistService, RESERVA_ACCOUNT_NAME, CLASS_LABELS,
  type WishlistMethodology,
} from '../../services/WishlistService';
import { pctOf, orcadoPrevistoGastoLinha, orcadoGastoLinha } from '../../lib/fluxoFormat';
import { TransactionService } from '../../services/TransactionService';
import { formatBRL } from '../../lib/money';
import {
  applyMonthEndBalanceHierarchy,
  removeClosingMonthOpening,
} from '../../lib/monthEndBalance';
import { monthAdd, monthOf, todaySP } from '../../lib/dates';
import { SETTING_KEYS } from '../../services/SettingsService';
import { clearLancamentos } from '../../db/seed';

let ctx: TestCtx;
let bank: BankMessageService;
let wish: WishlistService;
let tx: TransactionService;

beforeEach(async () => {
  ctx = await makeCtx();
  bank = new BankMessageService(ctx.db);
  wish = new WishlistService(ctx.db, ctx.services.transactions, ctx.services.balance);
  tx = ctx.services.transactions;
});
describe('v69 · 4 — Lista de Desejos: cadastro e reserva', () => {
  test('cadastro com classificação, descrição e valor (link opcional)', async () => {
    const id = await wish.addItem({ classificacao: 'PRIORIDADE', description: 'Notebook', targetCents: 200_000, link: 'https://loja.com/notebook' });
    const item = await wish.getById(id);
    expect(item?.classificacao).toBe('PRIORIDADE');
    expect(item?.description).toBe('Notebook');
    expect(item?.target_cents).toBe(200_000);
    expect(item?.reserved_cents).toBe(0);
    expect(item?.link).toBe('https://loja.com/notebook');
  });

  test('exige descrição, valor e classificação (os * são obrigatórios)', async () => {
    await expectRejects(() => wish.addItem({ classificacao: 'PRIORIDADE', description: '', targetCents: 100 }), /descri/i);
    await expectRejects(() => wish.addItem({ classificacao: 'PRIORIDADE', description: 'X', targetCents: 0 }), /valor/i);
    await expectRejects(() => wish.addItem({ classificacao: 'MUITO' as never, description: 'X', targetCents: 100 }), /classificação/i);
  });

  test('"Alterar" muda descrição, valor e link; valor não fica abaixo do reservado', async () => {
    const id = await wish.addItem({ classificacao: 'DESEJO', description: 'Fone', targetCents: 50_000 });
    await wish.updateItem(id, { description: 'Fone gamer', targetCents: 60_000, link: 'https://a.b/fone' });
    let item = await wish.getById(id);
    expect(item?.description).toBe('Fone gamer');
    expect(item?.target_cents).toBe(60_000);
    expect(item?.link).toBe('https://a.b/fone');
    // reserva 10.00 e tenta colocar valor 5.00 (abaixo do reservado) → erro
    await wish.reserve({ itemId: id, amountCents: 10_000, fromAccountId: await seedAccount(ctx.db, 'Origem', 100_000), destination: { kind: 'BOX' } });
    await expectRejects(() => wish.updateItem(id, { targetCents: 5_000 }), /abaixo do já reservado/);
    item = await wish.getById(id);
    expect(item?.target_cents).toBe(60_000);
  });

  test('RESERVA na caixinha: conta FORA do saldo geral e saldo geral cai', async () => {
    const origem = await seedAccount(ctx.db, 'Corrente', 100_000);
    const id = await wish.addItem({ classificacao: 'NECESSARIO', description: 'Air Fryer', targetCents: 40_000 });
    const { destinationAccountId } = await wish.reserve({ itemId: id, amountCents: 25_000, fromAccountId: origem, destination: { kind: 'BOX' } });
    // a caixinha nasce com include_in_general_balance = 0 (NUNCA no saldo)
    const box = await ctx.db.getFirstAsync<{ include_in_general_balance: number; name: string }>(
      'SELECT include_in_general_balance, name FROM accounts WHERE id = ?', [destinationAccountId]
    );
    expect(box?.name).toBe(RESERVA_ACCOUNT_NAME);
    expect(box?.include_in_general_balance).toBe(0);
    // o item soma reservado (62%)
    const item = await wish.getById(id);
    expect(item?.reserved_cents).toBe(25_000);
    // a origem perde 25.00 do saldo
    const saldo = await ctx.services.balance.getAccountBalance(origem);
    expect(saldo).toBe(75_000);
    // e o saldo geral não inclui a caixinha
    const geral = await ctx.services.balance.getGeneralBalance();
    expect(geral).toBe(75_000);
  });

  test('RESERVA na POUPANÇA fica em fatia SEPARADA (is_poupanca = 1)', async () => {
    const origem = await seedAccount(ctx.db, 'Salário', 200_000);
    const poupanca = await seedAccount(ctx.db, 'Poupança Itaú', 0);
    const id = await wish.addItem({ classificacao: 'DESEJO', description: 'Bicicleta', targetCents: 100_000 });
    const { destinationAccountId } = await wish.reserve({ itemId: id, amountCents: 30_000, fromAccountId: origem, destination: { kind: 'POUPANCA', accountId: poupanca } });
    expect(destinationAccountId).toBe(poupanca);
    const r = await ctx.db.getFirstAsync<{ is_poupanca: number; to_account_id: string }>(
      'SELECT is_poupanca, to_account_id FROM wishlist_reserves WHERE item_id = ?', [id]
    );
    expect(r?.is_poupanca).toBe(1);
    expect(r?.to_account_id).toBe(poupanca);
    // a fechinha da tela inicial vê a fatia por conta
    const mapa = await wish.reservesByAccount();
    expect(mapa[poupanca]?.totalCents).toBe(30_000);
    expect(mapa[poupanca]?.items[0]?.description).toBe('Bicicleta');
  });

  test('não reserva acima do que falta; barra 100% = "pronto para comprar"', async () => {
    const origem = await seedAccount(ctx.db, 'Corrente2', 500_000);
    const id = await wish.addItem({ classificacao: 'PRIORIDADE', description: 'Cadeira', targetCents: 10_000 });
    await expectRejects(() => wish.reserve({ itemId: id, amountCents: 20_000, fromAccountId: origem, destination: { kind: 'BOX' } }), /Só falta/);
    await wish.reserve({ itemId: id, amountCents: 10_000, fromAccountId: origem, destination: { kind: 'BOX' } });
    const views = await wish.listOpen();
    const item = views.flatMap((c) => c.items).find((i) => i.id === id)!;
    expect(item.pct).toBe(100);
    expect(item.pronto).toBe(true);
    expect(item.faltaCents).toBe(0);
  });

  test('"Comprar" (100%) tira da lista e vira LANÇAMENTO NORMAL', async () => {
    const origem = await seedAccount(ctx.db, 'Corrente3', 50_000);
    const id = await wish.addItem({ classificacao: 'PRIORIDADE', description: 'Livro', targetCents: 5_000 });
    await wish.reserve({ itemId: id, amountCents: 5_000, fromAccountId: origem, destination: { kind: 'BOX' } });
    // compra SEM informar conta: usa a própria caixinha de reserva
    const txId = await wish.buy({ itemId: id });
    const despesa = await ctx.db.getFirstAsync<{ type: string; amount_cents: number; account_id: string; description: string }>(
      'SELECT type, amount_cents, account_id, description FROM transactions WHERE id = ?', [txId]
    );
    expect(despesa?.type).toBe('EXPENSE');
    expect(despesa?.amount_cents).toBe(5_000);
    expect(despesa?.description).toBe('Livro');
    const box = await ctx.db.getFirstAsync<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE name = ?', [RESERVA_ACCOUNT_NAME]);
    expect(despesa?.account_id).toBe(box?.id);
    // o item SAI da lista (BOUGHT)
    const item = await wish.getById(id);
    expect(item?.status).toBe('BOUGHT');
    const abertos = await wish.listOpen();
    expect(abertos.flatMap((c) => c.items).find((i) => i.id === id)).toBeUndefined();
  });

  test('comprar SEM 100% reservado é bloqueado', async () => {
    const origem = await seedAccount(ctx.db, 'Corrente4', 50_000);
    const id = await wish.addItem({ classificacao: 'DESEJO', description: 'Jogo', targetCents: 10_000 });
    await expectRejects(() => wish.buy({ itemId: id }), /100%/);
  });

  test('"Excluir" remove item e reservas', async () => {
    const origem = await seedAccount(ctx.db, 'Corrente5', 80_000);
    const id = await wish.addItem({ classificacao: 'NECESSARIO', description: 'Mochila', targetCents: 8_000 });
    await wish.reserve({ itemId: id, amountCents: 2_000, fromAccountId: origem, destination: { kind: 'BOX' } });
    await wish.removeItem(id);
    expect(await wish.getById(id)).toBeNull();
    const rs = await ctx.db.getAllAsync('SELECT * FROM wishlist_reserves WHERE item_id = ?', [id]);
    expect(rs).toHaveLength(0);
  });

  test('caixinha é criada UMA vez (reuso entre reservas)', async () => {
    const origem = await seedAccount(ctx.db, 'Corrente6', 90_000);
    const a = await wish.addItem({ classificacao: 'DESEJO', description: 'A', targetCents: 5_000 });
    const b = await wish.addItem({ classificacao: 'DESEJO', description: 'B', targetCents: 5_000 });
    const r1 = await wish.reserve({ itemId: a, amountCents: 1_000, fromAccountId: origem, destination: { kind: 'BOX' } });
    const r2 = await wish.reserve({ itemId: b, amountCents: 1_000, fromAccountId: origem, destination: { kind: 'BOX' } });
    expect(r1.destinationAccountId).toBe(r2.destinationAccountId);
    const boxes = await ctx.db.getAllAsync('SELECT id FROM accounts WHERE name = ?', [RESERVA_ACCOUNT_NAME]);
    expect(boxes).toHaveLength(1);
  });
});

// ------------------------------------------------------- metodologia 5.2 ----

describe('v69 · 5 — metodologia da hierarquia (meses para comprar)', () => {
  test('capacidade para compras desconta Orçamento e prioriza itens antes da Poupança Mensal', async () => {
    const origem = await seedAccount(ctx.db, 'Hierarquia mensal', 100_000);
    const destino = await seedAccount(ctx.db, 'Poupança mensal', 0);
    const cat = await ctx.services.categories.create({
      name: 'Orçamento hierarquia', direction: 'DEBIT', icon: '🛒', parentId: null,
    });
    await ctx.services.budgets.save(cat.id, 30_000);
    await ctx.services.savings.createMonthlyPlan({
      amountCents: 20_000, dayOfMonth: 28, fromAccountId: origem, toAccountId: destino,
    });
    await ctx.services.savings.generateForecast('2026-10-01');
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'Item', targetCents: 100_000 });

    const [budgetSummary, savingsOverview] = await Promise.all([
      ctx.services.budgets.getMonthSummary('2026-10'),
      ctx.services.savings.getMonthOverview('2026-10'),
    ]);
    const methodology = await wish.getMethodology('2026-10', {
      budgetSummary,
      savingsOverview,
      saldoPrevistoAjustadoFimCents: 100_000,
    });

    expect(methodology.capacityCents).toBe(70_000);
  });

  test('sobra 1.500 x Prioridade 3.000 → várias meses; Necessário/Desejo SÓ começam depois', async () => {
    // conta com saldo que termina o mês em 1.500 (sem lançamentos: saldo constante)
    await seedAccount(ctx.db, 'Unica', 1_500);
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'Notebook', targetCents: 200_000 });
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'Celular', targetCents: 100_000 });
    await wish.addItem({ classificacao: 'NECESSARIO', description: 'Guarda-roupa', targetCents: 50_000 });
    await wish.addItem({ classificacao: 'DESEJO', description: 'Console', targetCents: 20_000 });
    const m: WishlistMethodology = await wish.getMethodology('2026-07');
    expect(m.sobraCents).toBe(1_500);
    expect(m.capacityCents).toBe(1_500);
    const prioridade = m.classes.find((c) => c.cls === 'PRIORIDADE')!;
    const necessario = m.classes.find((c) => c.cls === 'NECESSARIO')!;
    const desejo = m.classes.find((c) => c.cls === 'DESEJO')!;
    // Prioridade: 300.000 / 1.500 = 200 meses — começa no mês 1 e termina no 200º
    expect(prioridade.startMonth).toBe(1);
    expect(prioridade.endMonth).toBe(200);
    expect(m.monthsPrioridade).toBe(200);
    // Necessário SÓ começa quando a Prioridade TERMINAR (no exemplo do usuário,
    // "Necessário e Desejo nem começam esse mês")
    expect(necessario.startMonth).toBe(201);
    expect(desejo.startMonth).toBe(necessario.endMonth + 1);
    // frases pedidas pelo usuário
    expect(m.messagePrioridade).toBe('Para comprar tudo de Prioridade, você demora 200 meses.');
    expect(m.messageTotal).toBe(`Para comprar tudo, você demora ${m.monthsTotal} meses.`);
    expect(m.monthsTotal).toBe(desejo.endMonth);
  });

  describe('hierarquia do saldo previsto no fim do mês', () => {
    test('abate Orçamento, depois Programação de Compras e destina a sobra ao Fechamento', () => {
      expect(applyMonthEndBalanceHierarchy({
        balanceCents: 200_000,
        budgetRemainingCents: 50_000,
        monthlySavingsCents: 30_000,
        wishlistOutstandingCents: 80_000,
        closingMode: false,
      })).toBe(40_000);

      expect(applyMonthEndBalanceHierarchy({
        balanceCents: 200_000,
        budgetRemainingCents: 50_000,
        monthlySavingsCents: 30_000,
        wishlistOutstandingCents: 80_000,
        closingMode: true,
      })).toBe(0);
    });

    test('não transforma saldo negativo em zero quando há Fechamento do Mês', () => {
      expect(applyMonthEndBalanceHierarchy({
        balanceCents: 10_000,
        budgetRemainingCents: 20_000,
        monthlySavingsCents: 5_000,
        wishlistOutstandingCents: 100_000,
        closingMode: true,
      })).toBe(-15_000);
    });

    test('Programação de Compras vem antes da Poupança Mensal na ordem de abatimentos', () => {
      expect(applyMonthEndBalanceHierarchy({
        balanceCents: 100_000,
        budgetRemainingCents: 20_000,
        wishlistOutstandingCents: 70_000,
        monthlySavingsCents: 50_000,
        closingMode: false,
      })).toBe(-40_000);
    });

    test('o dia 1 do mês regido pelo Fechamento começa sem carregar saldo positivo', () => {
      expect(removeClosingMonthOpening(
        { '2026-11-01': 100_000, '2026-11-02': 110_000 },
        100_000,
        true
      )).toEqual({ '2026-11-01': 0, '2026-11-02': 10_000 });
    });
  });

  test('prioridade que CABE no mês libera a classificação seguinte no mês seguinte', async () => {
    await seedAccount(ctx.db, 'Unica2', 2_000);
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 1_500 });
    await wish.addItem({ classificacao: 'NECESSARIO', description: 'N', targetCents: 1_000 });
    const m = await wish.getMethodology('2026-08');
    const p = m.classes.find((c) => c.cls === 'PRIORIDADE')!;
    const n = m.classes.find((c) => c.cls === 'NECESSARIO')!;
    expect(p.startMonth).toBe(1);
    expect(p.endMonth).toBe(1); // 1.500 cabe nos 2.000 do mês
    expect(n.startMonth).toBe(2); // Necessário começa no mês SEGUNTE
    expect(m.monthsTotal).toBe(2);
  });

  test('sem sobra: nenhuma classificação começa (mensagem de aviso)', async () => {
    await seedAccount(ctx.db, 'Zero', 0);
    await wish.addItem({ classificacao: 'PRIORIDADE', description: 'P', targetCents: 1_000 });
    const m = await wish.getMethodology('2026-09');
    expect(m.sobraCents).toBe(0);
    const p = m.classes.find((c) => c.cls === 'PRIORIDADE')!;
    expect(p.startMonth).toBe(0);
    expect(p.endMonth).toBe(0);
    expect(m.messagePrioridade).toBe('Sem sobra prevista neste mês — nada começa a reservar.');
  });

  test('metodologia expõe Orçamento e Poupança Mensal (obrigatórios, entram primeiro)', async () => {
    await seedAccount(ctx.db, 'Hierarquia', 5_000);
    const m = await wish.getMethodology('2026-10');
    // módulos desligados → null (rótulos "desligado" na tela)
    expect(m.budgetedCents).toBeNull();
    expect(m.poupancaMensalCents).toBeNull();
  });

  test('CLASS_LABELS das 3 classificações', () => {
    expect(CLASS_LABELS.PRIORIDADE).toBe('Prioridade');
    expect(CLASS_LABELS.NECESSARIO).toBe('Necessário');
    expect(CLASS_LABELS.DESEJO).toBe('Desejo');
  });
});

// ------------------------------------------- poupança do card do Fluxo ----

describe('v69 · 6 — Poupança do Fluxo (cabeçalho, programado, falta, transferido)', () => {
  test('plano FECHAMENTO cadastrado: programado inclui o saldo que sobraria (não fica R$ 0,00)', async () => {
    const origem = await seedAccount(ctx.db, 'Conta P', 10_000);
    const destino = await seedAccount(ctx.db, 'Poupança P', 0);
    await ctx.services.savings.createClosingPlan({ fromAccountId: origem, toAccountId: destino });
    const month = '2026-11';
    const o = await ctx.services.savings.getMonthOverview(month);
    // planos cadastrados aparecem MESMO sem entradas no mês (bug "Nenhum plano")
    expect(o.plans).toHaveLength(1);
    expect(o.plans[0].modalityLabel).toBe('Fechamento do mês');
    // o saldo previsto do fim do mês é 100.00 → programado = 10.000
    expect(o.programadoCents).toBe(10_000);
    expect(o.closingSuggestion?.amountCents).toBe(10_000);
    // falta transferir = programado − já transferido = 10.000 − 0
    expect(o.remainingCents).toBe(10_000);
    expect(o.effectedCents).toBe(0);
  });

  test('"Falta transferir" desconta o que já foi transferido (10 mil − 500 = 9.500)', async () => {
    const origem = await seedAccount(ctx.db, 'Conta F', 10_000);
    const destino = await seedAccount(ctx.db, 'Poupança F', 0);
    // dia 28 (ainda não venceu): a previsão do mês nasce PENDING — preciso transferir 10 mil
    await ctx.services.savings.createMonthlyPlan({ amountCents: 10_000, dayOfMonth: 28, fromAccountId: origem, toAccountId: destino });
    // v69: previsões determinísticas — gera a do mês visto como se hoje fosse 01/11
    await ctx.services.savings.generateForecast('2026-11-01');
    // transfere 500 manualmente (CONFIRMED) para a conta poupança do plano — "já transferido"
    await tx.createTransfer({ fromAccountId: origem, toAccountId: destino, amountCents: 500, date: '2026-11-02', description: 'Poupança avulsa' });
    const o = await ctx.services.savings.getMonthOverview('2026-11');
    // programado = 10.000 (previsão do plano mensal do mês); efetivado = 500 (transferência confirmada)
    expect(o.programadoCents).toBe(10_000);
    expect(o.effectedCents).toBe(500);
    expect(o.remainingCents).toBe(9_500);
    // plano aparece mesmo assim (é do MONTHLY, com valor)
    expect(o.plans).toHaveLength(1);
    expect(o.plans[0].amountCents).toBe(10_000);
    // guardado do plano do mês: a previsão do dia 28 ainda PENDING — guardado 0, falta 10.000
    expect(o.plans[0].guardadoCents).toBe(0);
    expect(o.plans[0].faltaCents).toBe(10_000);
  });

  test('"Já transferido p/ poupança" conta CONFIRMADAS do mês com destino em plano ativo; previsões futuras não contam', async () => {
    const origem = await seedAccount(ctx.db, 'Conta T', 20_000);
    const destino = await seedAccount(ctx.db, 'Poupança T', 0);
    // plano ativo dá o DESTINO válido para as transferências avulsas contarem
    await ctx.services.savings.createMonthlyPlan({ amountCents: 700, dayOfMonth: 28, fromAccountId: origem, toAccountId: destino });
    await ctx.services.savings.generateForecast('2026-11-01');
    // uma CONFIRMED (no mês) e uma PENDING futura (mês seguinte)
    await tx.createTransfer({ fromAccountId: origem, toAccountId: destino, amountCents: 700, date: '2026-11-05', description: 'T1' });
    await tx.createTransfer({ fromAccountId: origem, toAccountId: destino, amountCents: 300, date: '2026-12-05', description: 'T2' });
    const o = await ctx.services.savings.getMonthOverview('2026-11');
    expect(o.effectedCents).toBe(700);
    expect(o.programadoCents).toBe(700); // previsão do plano (PENDING) + avulsa confirmada (não duplica)
    expect(o.remainingCents).toBe(0);
  });
});

// ----------------------------------------------------- formato da linha ----

describe('v94 · 7 — linha "Orçado • Gasto" (uma linha, % por movimento, sem Previsto)', () => {
  test('porcentagem por movimento — exemplo 1 do usuário (400/0 de 400 → 100/0)', () => {
    expect(pctOf(400, 400)).toBe(100);
    expect(pctOf(0, 400)).toBe(0);
    const linha = orcadoGastoLinha(40_000, 0);
    expect(linha).toBe(
      `Orçado ${formatBRL(40000)} (100%) • Gasto ${formatBRL(0)} (0%)`
    );
  });

  test('porcentagem por movimento — exemplo 2 do usuário (350/100 de 450 → 78/22)', () => {
    // 350/450 = 77,77… → 78; 100/450 = 22,22… → 22.
    expect(pctOf(350, 450)).toBe(78);
    expect(pctOf(100, 450)).toBe(22);
    const linha = orcadoGastoLinha(35_000, 10_000);
    expect(linha).toBe(
      `Orçado ${formatBRL(35000)} (78%) • Gasto ${formatBRL(10000)} (22%)`
    );
  });

  test('total zerado não divide por zero', () => {
    expect(pctOf(0, 0)).toBe(0);
    expect(orcadoGastoLinha(0, 0)).toBe(
      `Orçado ${formatBRL(0)} (0%) • Gasto ${formatBRL(0)} (0%)`
    );
  });

  test('estouro arredonda sem decimal', () => {
    expect(pctOf(1, 3)).toBe(33);
    expect(pctOf(2, 3)).toBe(67);
  });

  // v69 mantida para compat: testa que o helper legado (3 números) ainda
  // monta a linha com "Previsto" no meio — alguns testes antigos podem usar.
  test('helper legado orcadoPrevistoGastoLinha continua renderizando o Previsto', () => {
    const linha = orcadoPrevistoGastoLinha(35_000, 16_000, 0);
    expect(linha).toContain('Previsto');
    expect(linha).toContain(`Orçado ${formatBRL(35000)}`);
  });
});

// ----------------------------------------------------- v94 · Efetivar Fechamento ----

describe('v94 · 8 — Efetivar Fechamento do Mês (botão "Efetivar")', () => {
  /** Sobe um cenário CLOSING clássico: 1 conta com saldo positivo e plano
   *  CLOSING ativo — sobra vira estimativa de fechamento. */
  async function setupClosing(mes: string) {
    const { services, db } = await makeCtx();
    const origem = await seedAccount(services.db, 'Conta Origem', 100_000);
    const destinoId = `acc-dest-${Math.random().toString(36).slice(2, 8)}`;
    await db.runAsync(
      "INSERT INTO accounts (id, name, type, initial_balance_cents, include_in_general_balance) VALUES (?,?,?,?,0)",
      [destinoId, 'Caderneta', 'SAVINGS', 0]
    );
    await services.savings.createClosingPlan({ fromAccountId: origem, toAccountId: destinoId });
    // garante SALDO POSITIVO previsto no fim do mês para que a sugestão apareça
    return { services, db, origem, destinoId };
  }

  test('cria + efetiva a transferência do fechamento a partir da SUGESTÃO viva', async () => {
    const mes = monthOf(todaySP());
    const { services, db } = await setupClosing(mes);
    const ov0 = await services.savings.getMonthOverview(mes);
    expect(ov0.closingSuggestion).not.toBeNull();
    const expected = ov0.closingSuggestion!.amountCents;

    const r = await services.savings.efetivarFechamento(mes);
    expect(r.efetivadas).toBe(1);
    expect(r.amountCents).toBe(expected);

    // entrada CLOSING do mês com transação CONFIRMED e valor = expected
    const row = await db.getFirstAsync<{
      amount_cents: number; kind: string; tx_status: string;
    }>(
      `SELECT se.amount_cents, se.kind, t.status AS tx_status
         FROM savings_entries se
         LEFT JOIN transactions t ON t.id = se.transaction_id
        WHERE se.month = ? AND se.kind = 'CLOSING'`,
      [mes]
    );
    expect(row?.amount_cents).toBe(expected);
    expect(row?.tx_status).toBe('CONFIRMED');
    // sugestão seguinte some (já confirmado)
    const ov2 = await services.savings.getMonthOverview(mes);
    expect(ov2.closingSuggestion).toBeNull();
  });

  test('segundo toque: efetiva a transferência PENDING já criada', async () => {
    const mes = monthOf(todaySP());
    const { services } = await setupClosing(mes);
    // cria a transferência PENDING via confirmClosing (equivale ao 1º toque)
    const sug = (await services.savings.getClosingSuggestion(mes))!;
    await services.savings.confirmClosing(mes, sug.amountCents);
    const r = await services.savings.efetivarFechamento(mes);
    expect(r.efetivadas).toBe(1);
    expect(r.amountCents).toBe(sug.amountCents);
  });

  test('sem plano CLOSING ativo OU sem sobra → devolve efetivadas = 0', async () => {
    const { services } = await makeCtx();
    const mes = monthOf(todaySP());
    // sem plano CLOSING, com saldo zerado
    const r = await services.savings.efetivarFechamento(mes);
    expect(r.efetivadas).toBe(0);
    expect(r.amountCents).toBe(0);
    void services;
  });
});

// --------------------------------------------- limpeza de dados (DADOS) ----

describe('Saldo final e ordem de cadastro dos módulos', () => {
  test('saldo previsto final mantém a hierarquia ao cadastrar orçamento, lista e poupança em ordens diferentes', async () => {
    const orders = [
      ['budget', 'wishlist', 'savings'],
      ['wishlist', 'savings', 'budget'],
      ['savings', 'budget', 'wishlist'],
    ] as const;
    const results: Array<number | null> = [];
    const month = monthAdd(monthOf(todaySP()), 1);

    for (const order of orders) {
      const { db, services } = await makeCtx();
      const fromAccountId = await seedAccount(db, 'Saldo previsto', 100_000);
      const toAccountId = await seedAccount(db, 'Destino poupança');
      // v88: o app não cria mais categorias de seed — o teste cria a sua
      await seedCategory(db, 'Mercado', 'cat-mercado');
      await services.settings.setBool(SETTING_KEYS.budgetsAtivado, true);
      await services.settings.setBool(SETTING_KEYS.wishlistNaHome, true);
      await services.settings.setBool(SETTING_KEYS.poupancaAtivado, true);

      for (const module of order) {
        if (module === 'budget') await services.budgets.save('cat-mercado', 10_000);
        if (module === 'wishlist') {
          await services.wishlist.addItem({
            classificacao: 'PRIORIDADE',
            description: 'Compra programada',
            targetCents: 30_000,
          });
        }
        if (module === 'savings') {
          await services.savings.createMonthlyPlan({
            amountCents: 20_000,
            dayOfMonth: 28,
            fromAccountId,
            toAccountId,
          });
        }
      }

      await services.savings.createClosingPlan({ fromAccountId, toAccountId });
      results.push((await services.savings.getClosingSuggestion(month))?.amountCents ?? null);
    }

    expect(results).toEqual([40_000, 40_000, 40_000]);
  });
});
