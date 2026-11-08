/**
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

import { makeCtx, seedAccount, expectRejects, type TestCtx } from './helpers';
import {
  BankMessageService, parseBankMessage, parseValorTexto,
} from '../services/BankMessageService';
import {
  WishlistService, RESERVA_ACCOUNT_NAME, CLASS_LABELS,
  type WishlistMethodology,
} from '../services/WishlistService';
import { pctOf, orcadoPrevistoGastoLinha } from '../lib/fluxoFormat';
import { TransactionService } from '../services/TransactionService';
import { formatBRL } from '../lib/money';
import { clearLancamentos } from '../db/seed';

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

// ---------------------------------------------------------------- parser ----

describe('v69 · 1 — parser de mensagens bancárias', () => {
  test('compra no débito com valor, data e estabelecimento', () => {
    const p = parseBankMessage('Compra aprovada: SHOPEE R$ 149,90 em 12/05/2026 às 14:02');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('DEBIT');
    expect(p!.amountCents).toBe(14990);
    expect(p!.date).toBe('2026-05-12');
    expect(p!.description?.toLowerCase()).toContain('shopee');
  });

  test('PIX recebido é crédito', () => {
    const p = parseBankMessage('Pix recebido de JOAO SILVA. Valor: R$ 1.234,56. 13/05/2026');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('CREDIT');
    expect(p!.amountCents).toBe(123456);
  });

  test('assinatura/streaming cai como débito', () => {
    const p = parseBankMessage('Pagamento efetuado — assinatura NETFLIX R$ 55,90 10/06/2026');
    expect(p).not.toBeNull();
    expect(p!.kind).toBe('DEBIT');
    expect(p!.amountCents).toBe(5590);
  });

  test('data curta dd/mm usa o ano corrente (e ano passado se ficar no futuro)', () => {
    const p = parseBankMessage('Compra aprovada R$ 10,00 em 01/01');
    expect(p).not.toBeNull();
    expect(p!.date).toMatch(/^\d{4}-01-01$/);
  });

  test('mensagem sem valor não entra na lista (null)', () => {
    expect(parseBankMessage('Seu extrato do dia está disponível no app')).toBeNull();
    expect(parseBankMessage('')).toBeNull();
  });

  test('parseValorTexto lê os formatos pt-BR', () => {
    expect(parseValorTexto('1.234,56')).toBe(123456);
    expect(parseValorTexto('149,90')).toBe(14990);
    expect(parseValorTexto('10')).toBe(1000);
    expect(parseValorTexto('')).toBeNull();
  });
});

// ---------------------------------------------------------------- ingest ----

describe('v69 · 2 — ingest na lista (nunca cria lançamento sozinho)', () => {
  test('mensagem entra com status NEW e NÃO cria transação', async () => {
    const r = await bank.ingest('Nubank', 'Compra aprovada: SHOPEE R$ 149,90 em 12/05/2026');
    expect(r.inserted).toBe(true);
    const pend = await bank.listPending();
    expect(pend).toHaveLength(1);
    expect(pend[0].status).toBe('NEW');
    expect(pend[0].amount_cents).toBe(14990);
    const txCount = await ctx.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txCount?.n).toBe(0); // nunca cria lançamento sozinho
  });

  test('mesma mensagem não entra duas vezes (idempotente)', async () => {
    const corpo = 'Compra aprovada: AMAZON R$ 89,90 em 02/06/2026';
    const a = await bank.ingest('Nubank', corpo);
    const b = await bank.ingest('Nubank', corpo);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(await bank.listPending()).toHaveLength(1);
  });

  test('"Deletar" tira da lista (DESCARTADA)', async () => {
    const r = await bank.ingest(null, 'Compra aprovada: IFOOD R$ 42,50 em 03/06/2026');
    await bank.discard(r.id!);
    expect(await bank.listPending()).toHaveLength(0);
    const row = await bank.getById(r.id!);
    expect(row?.status).toBe('DESCARTADA');
  });
});

// ---------------------------------------------------- conciliação com OFX ----

describe('v69 · 3 — lançar mensagem concilia OFX por data + valor', () => {
  test('OFX importado ANTES: markLancado vincula a linha na hora (sem duplicar)', async () => {
    const acc = await seedAccount(ctx.db, 'Banco', 500_000);
    // 1) OFX já importado com a despesa de -149,90 em 2026-05-12
    const ofxContent = [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      'VERSION:102',
      '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260512</DTPOSTED><TRNAMT>-149.90</TRNAMT><FITID>F1</FITID><MEMO>SHOPEE</MEMO>',
    ].join('\n');
    const res = await ctx.services.ofx.importOfx(acc, ofxContent);
    expect(res.newTransactions).toBe(1);

    // 2) mensagem bancária da mesma compra
    const m = await bank.ingest('Nubank', 'Compra aprovada: SHOPEE R$ 149,90 em 12/05/2026');
    // 3) usuário LANÇA (pela tela, vira createAccountExpense) — o serviço marca
    const txRow = await tx.createAccountExpense({
      description: 'SHOPEE',
      amountCents: 14990,
      date: '2026-05-12',
      accountId: acc,
    });
    const vinculadas = await bank.markLancado(m.id!, txRow.id, acc);
    expect(vinculadas).toBe(1);
    // a linha OFX ficou MATCHED_AUTO apontando para o lançamento do usuário
    const linha = await ctx.db.getFirstAsync<{ match_status: string; matched_transaction_id: string }>(
      'SELECT match_status, matched_transaction_id FROM ofx_statement_lines WHERE fitid = ?',
      ['F1']
    );
    expect(linha?.match_status).toBe('MATCHED_AUTO');
    expect(linha?.matched_transaction_id).toBe(txRow.id);
    // e a mensagem ficou LANCADO com o lançamento
    const msg = await bank.getById(m.id!);
    expect(msg?.status).toBe('LANCADO');
    expect(msg?.transaction_id).toBe(txRow.id);
    // v70 (BUG 1.5): a linha era NEW_TX (o OFX tinha criado lançamento próprio).
    // Ao lançar a notificação, o duplicado criado pelo OFX FOI APAGADO —
    // o mesmo dinheiro não é contado duas vezes (fica só o do usuário).
    const txCount = await ctx.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    expect(txCount?.n).toBe(1);
  });

  test('OFX importado DEPOIS: casamento padrão acha o lançamento (MATCHED_AUTO, nada novo)', async () => {
    const acc = await seedAccount(ctx.db, 'Banco2', 300_000);
    // 1) mensagem → usuário lança
    const m = await bank.ingest('Inter', 'Compra aprovada: MERCADO LIVRE R$ 200,00 em 20/06/2026');
    const txRow = await tx.createAccountExpense({
      description: 'MERCADO LIVRE',
      amountCents: 20000,
      date: '2026-06-20',
      accountId: acc,
    });
    await bank.markLancado(m.id!, txRow.id, acc);
    // 2) OFX chega depois com a MESMA data + valor
    const ofxContent = [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      'VERSION:102',
      '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260620</DTPOSTED><TRNAMT>-200.00</TRNAMT><FITID>F2</FITID><MEMO>MERCADO LIVRE</MEMO>',
    ].join('\n');
    const res = await ctx.services.ofx.importOfx(acc, ofxContent);
    expect(res.matchedAuto).toBe(1); // conciliou com o lançamento da mensagem
    expect(res.newTransactions).toBe(0); // NÃO duplicou
    const linha = await ctx.db.getFirstAsync<{ match_status: string; matched_transaction_id: string }>(
      'SELECT match_status, matched_transaction_id FROM ofx_statement_lines WHERE fitid = ?',
      ['F2']
    );
    expect(linha?.match_status).toBe('MATCHED_AUTO');
    expect(linha?.matched_transaction_id).toBe(txRow.id);
  });

  test('OFX com valor DIFERENTE não é vinculado pela conciliação da mensagem', async () => {
    const acc = await seedAccount(ctx.db, 'Banco3', 100_000);
    const ofxContent = [
      'OFXHEADER:100',
      'DATA:OFXSGML',
      'VERSION:102',
      '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260701</DTPOSTED><TRNAMT>-99.00</TRNAMT><FITID>F3</FITID><MEMO>OUTRO</MEMO>',
    ].join('\n');
    await ctx.services.ofx.importOfx(acc, ofxContent);
    const m = await bank.ingest(null, 'Compra aprovada: LOJA X R$ 12,00 em 01/07/2026');
    const txRow = await tx.createAccountExpense({ description: 'LOJA X', amountCents: 1200, date: '2026-07-01', accountId: acc });
    const vinculadas = await bank.markLancado(m.id!, txRow.id, acc);
    expect(vinculadas).toBe(0);
  });
});

// ------------------------------------------------------ lista de desejos ----

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

describe('v69 · 7 — linha "Orçado • Previsto • Gasto" (uma linha, % redonda)', () => {
  test('porcentagem por movimento — exemplo 1 do usuário (160/0 de 160 movimentados)', () => {
    expect(pctOf(160, 160)).toBe(100);
    expect(pctOf(0, 160)).toBe(0);
    const linha = orcadoPrevistoGastoLinha(35_000, 16_000, 0);
    expect(linha).toBe(
      `Orçado ${formatBRL(35000)} • Previsto ${formatBRL(16000)} (100%) • Gasto ${formatBRL(0)} (0%)`
    );
  });

  test('porcentagem por movimento — exemplo 2 do usuário (250/100 de 350 movimentados)', () => {
    expect(pctOf(250, 350)).toBe(71); // 71,42… → 71 (número redondo, sem decimal)
    expect(pctOf(100, 350)).toBe(29); // 28,57… → 29
    const linha = orcadoPrevistoGastoLinha(35_000, 25_000, 10_000);
    expect(linha).toBe(
      `Orçado ${formatBRL(35000)} • Previsto ${formatBRL(25000)} (71%) • Gasto ${formatBRL(10000)} (29%)`
    );
  });

  test('total zerado não divide por zero', () => {
    expect(pctOf(0, 0)).toBe(0);
    expect(orcadoPrevistoGastoLinha(10_000, 0, 0)).toBe(
      `Orçado ${formatBRL(10000)} • Previsto ${formatBRL(0)} (0%) • Gasto ${formatBRL(0)} (0%)`
    );
  });

  test('estouro arredonda sem decimal', () => {
    expect(pctOf(1, 3)).toBe(33);
    expect(pctOf(2, 3)).toBe(67);
  });
});

// --------------------------------------------- limpeza de dados (DADOS) ----

describe('v69 · 8 — limpeza de dados com as tabelas novas', () => {
  test('limpar lançamentos: mensagens LANCADAS saem, pendentes voltam; reservas zeram', async () => {
    const acc = await seedAccount(ctx.db, 'L1', 100_000);
    const m1 = await bank.ingest(null, 'Compra aprovada: A R$ 10,00 em 12/07/2026');
    const m2 = await bank.ingest(null, 'Compra aprovada: B R$ 20,00 em 13/07/2026');
    const t = await tx.createAccountExpense({ description: 'A', amountCents: 1_000, date: '2026-07-12', accountId: acc });
    await bank.markLancado(m1.id!, t.id, acc);
    const itemId = await wish.addItem({ classificacao: 'DESEJO', description: 'X', targetCents: 5_000 });
    await wish.reserve({ itemId, amountCents: 1_000, fromAccountId: acc, destination: { kind: 'BOX' } });

    await clearLancamentos(ctx.db);

    // m1 (LANCADO) sai; m2 (NEW) continua na lista
    expect(await bank.getById(m1.id!)).toBeNull();
    const pend = await bank.listPending();
    expect(pend).toHaveLength(1);
    expect(pend[0].id).toBe(m2.id);
    // item aberto volta com reservado 0
    const item = await wish.getById(itemId);
    expect(item?.reserved_cents).toBe(0);
    expect(item?.status).toBe('OPEN');
    // saldo da conta volta ao inicial (transferência da reserva foi apagada)
    expect(await ctx.services.balance.getAccountBalance(acc)).toBe(100_000);
  });
});
