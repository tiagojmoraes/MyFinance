/**
 * v67 — CORREÇÕES DOS 6 BUGs + 3 MELHORIAS (pedido do usuário).
 *  Roda: npm test -- --runInBand src/__tests__/flow-ui-and-account-regressions.test.ts
 *
 *  BUG 1 — Fluxo: cabeçalho do dia em LINHAS EMPILHADAS (saldo do dia
 *          Previsto/Efetivado não divide mais a linha com orçamentos/poupança).
 *  BUG 2 — Fluxo: esqueleto ÚNICO das linhas virou o componente LancamentoRow
 *          (lançamentos, parcelas, grupos, faturas e cards Orçamento/Poupança).
 *  BUG 3 — Fluxo: saldo do cabeçalho dos cards NUNCA desaparece (fallback 0).
 *  BUG 4 — Orçamento item ▸ subitem: pai = soma dos subitens (100 = 60 + 40);
 *          excluir pergunta o destino (só o item / item + subitens).
 *  BUG 5 — Categorias: cada direção tem a sua lista; trocar Débito↔Crédito
 *          limpa a categoria que não pertence ao novo tipo.
 *  BUG 6 — Cartões: topo = PRÓXIMA fatura em aberto (mais antiga não quitada);
 *          sem fatura → R$ 0,00 · "Sem fatura em aberto" (por cartão).
 *  MELHORIA 1 — NFC-e: fluxo guiado item a item (EAN→Alias→Fuzzy→novo
 *          classificado na hora com categoria de débito→estoque: Apenas agora
 *          / Sempre = pantry_policy NUNCA).
 *  MELHORIA 2 — Catálogo de Produto: menu no Cadastro, lista sem EAN, excluir
 *          SÓ DESVINCULA (notas/lançamentos preservados).
 *  MELHORIA 3 — Recorrência/Parcelamentos saem SÓ da tela Fluxo (dados intactos).
 */

import * as fs from 'fs';
import * as path from 'path';
import { makeCtx, seedAccount } from './helpers';
import { categoryMatchesFilter, filterForKind } from '../lib/categories';
import { monthOf, todaySP } from '../lib/dates';

const root = path.join(__dirname, '..', '..');
const fluxoSrc = () => fs.readFileSync(path.join(root, 'app', 'fluxo.tsx'), 'utf8');
const lancSrc = () => fs.readFileSync(path.join(root, 'app', 'lancamento.tsx'), 'utf8');
const nfceSrc = () => fs.readFileSync(path.join(root, 'app', 'nfce', '[key].tsx'), 'utf8');

// ───────────────────────── fixtures NFC-e (mesmo layout SEFAZ-SP do v37) ─────────────────────────

const CNPJ_ASSAI = '06.057.223/0508-61';

let seq = 0;
const genKey = () => `3526${String(++seq).padStart(4, '0')}9140216900018765001000000000000000000000`.slice(0, 44);

const itemRow = (desc: string, code: string, qty: string, unit: string, unitPrice: string, total: string) => `
<tr id="Item + 1"><td>
<span class="txtTit">${desc}</span>
<span class="RCod">(Código: ${code} )</span><br/>
<span class="Rqtd"><strong>Qtde.:</strong>${qty}</span>
<span class="RUN"><strong>UN: </strong>${unit}</span>
<span class="RvlUnit"><strong>Vl. Unit.:</strong> ${unitPrice}</span></td>
<td class="txtTit noWrap">Vl. Total<br/><span class="valor">${total}</span></td></tr>`;

const notaHtml = (razao: string, cnpj: string, linhas: string) => `
<html><body>
<div class="txtTopo">${razao}</div>
<div>Nome Empresarial: ${razao}</div>
<div>CNPJ: ${cnpj}</div>
<div>Data e Hora da Emissão: 31/10/2026 14:20:12</div>
<table id="tabResult"><tbody>${linhas}</tbody></table>
<div>Valor Total: R$ 15,40</div>
<div>Valor Pago: R$ 15,40</div>
</body></html>`;

async function ingest(key: string, html: string) {
  const { services } = ctx!;
  await services.nfce.ingestFromHtml(key, html, null);
  return services.nfce.processItems(key, html);
}

async function itemsOf(key: string) {
  const { db } = ctx!;
  return db.getAllAsync<{
    id: string; description: string | null; store_product_code: string | null;
    ean_extracted: string | null; product_id: string | null; match_type: string | null;
    status: string; stock_applied: number;
  }>('SELECT id, description, store_product_code, ean_extracted, product_id, match_type, status, stock_applied FROM nfce_items WHERE access_key = ? ORDER BY line_number', [key]);
}

let ctx: Awaited<ReturnType<typeof makeCtx>> | null = null;
beforeEach(async () => {
  ctx = await makeCtx();
});

// ═══════════════════════════════ BUG 2 — LancamentoRow ÚNICO ═══════════════════════════════

describe('v67 BUG 2 — esqueleto único LancamentoRow no Fluxo', () => {
  test('componente existe e é o esqueleto único (Card de linha só no componente)', () => {
    const compPath = path.join(root, 'src', 'components', 'LancamentoRow.tsx');
    expect(fs.existsSync(compPath)).toBe(true);
    const comp = fs.readFileSync(compPath, 'utf8');
    expect(comp).toContain('export function LancamentoRow');
    // O esqueleto (card de linha) vive APENAS no componente — sem cópia na tela
    expect(comp).toContain('flex-row justify-between items-start gap-2');
    expect(fluxoSrc()).not.toContain('rounded-lg bg-violet-50 items-center justify-center');
  });

  test('fluxo.tsx usa LancamentoRow em TODAS as linhas (tx/grupo/parcela/fatura/orçamento/poupança)', () => {
    const src = fluxoSrc();
    expect(src).toContain("import { LancamentoRow } from '../src/components/LancamentoRow'");
    // renderFlowCard delega ao componente (adaptador com a assinatura antiga)
    expect(src).toMatch(/const renderFlowCard = \(a: \{[\s\S]*?\}\) => \(\s*<LancamentoRow/);
    // fatura usa o MESMO esqueleto (antes era card próprio)
    expect(src).toMatch(/const renderInvoiceCard = \(inv: InvoiceAgg\) => \{[\s\S]*?<LancamentoRow/);
    // cards de Orçamento e Poupança também
    expect(src).toMatch(/const budgetCard = budgetsOn \? \(\s*<LancamentoRow/);
    expect(src).toMatch(/const savingsCard = savingsOn \? \(\s*<LancamentoRow/);
  });
});

// ═══════════════════════════════ BUG 1 — cabeçalho do dia empilhado ═══════════════════════════════
// v68: a linha "Orçamentos: falta" SAIU — o orçamento e a poupança agora
// ENTRAM no número do saldo do dia (dailyShown memoizado), por pedido do
// usuário ("não criar um bloco chamado Orçamentos:").

describe('v67 BUG 1 (atualizado na v68) — saldo do dia sem bloco de orçamentos', () => {
  test('saldo Previsto/Efetivado em linha própria; a linha "Orçamentos:" NÃO existe mais', () => {
    const src = fluxoSrc();
    // v68: o bloco informativo "Orçamentos: falta" foi removido de vez
    expect(src).not.toContain('Resumo de orçamentos do mês');
    expect(src).not.toContain('Orçamentos: falta');
    // os dois saldos continuam em linhas empilhadas (v67 mantido)
    expect(src).toContain('Saldo do dia Previsto:');
    expect(src).toContain('Saldo do dia Efetivado:');
  });

  test('v68: o saldo exibido é o dailyShown (base + Orçamento + Poupança, memoizado)', () => {
    const src = fluxoSrc();
    expect(src).toContain('const dailyShown = React.useMemo(');
    expect(src).toMatch(/dailyShown\.previsto\[day\]/);
    expect(src).toMatch(/dailyShown\.efetivado\[day\]/);
    // composição pedida: base + ajustes de Orçamento e Poupança
    expect(src).toMatch(/\(budAdj\?\.previsto\[d\] \?\? 0\)/);
    expect(src).toMatch(/\(savAdj\?\.previsto\[d\] \?\? 0\)/);
    expect(src).toMatch(/\(budAdj\?\.efetivado\[d\] \?\? 0\)/);
    expect(src).toMatch(/\(savAdj\?\.efetivado\[d\] \?\? 0\)/);
  });

  test('rótulos da Poupança não competem com o vocabulário do saldo do dia', () => {
    const src = fluxoSrc();
    expect(src).toContain('Programado p/ poupança');
    expect(src).toContain('Já transferiu p/ poupança');
    expect(src).not.toContain('Previsão do mês (programado)');
    expect(src).not.toContain('Falta (a efetivar)');
  });

  test('REGRESSÃO: sem módulos ativos, o saldo do dia continua sendo o do BalanceService', async () => {
    const { services } = await ctx!;
    const acc = await seedAccount(services.db, 'Conta Fluxo', 10_000);
    await services.transactions.createAccountExpense({
      description: 'Mercado', amountCents: 1_500, accountId: acc, date: `${monthOf(todaySP())}-10`,
    });
    const dual = await services.balance.getDailyBalancesDual(monthOf(todaySP()));
    // à vista nasce PENDING: entra no previsto do dia; efetivado só quando promover
    expect(dual.previsto[`${monthOf(todaySP())}-10`]).toBe(8_500);
    expect(dual.efetivado[`${monthOf(todaySP())}-28`]).toBe(10_000);
    expect(dual.previsto[`${monthOf(todaySP())}-28`]).toBe(8_500);
    // v68: com módulos desligados, o ajuste de saldo é ZERO (não muda a conta)
    expect(await services.budgets.getMonthFluxAdjust(monthOf(todaySP()), [acc])).toEqual({ previsto: {}, efetivado: {} });
  });
});

// ═══════════════════════════════ BUG 3 — saldo do cabeçalho nunca some ═══════════════════════════════

describe('v67 BUG 3 — saldo do cabeçalho dos cards sempre visível', () => {
  test('cabeçalho usa fallback ?? 0 (R$ 0,00 quando não há dados)', () => {
    const src = fluxoSrc();
    expect(src).toContain('formatBRL(budgetSum?.remainingCents ?? 0)');
    // v69: o cabeçalho da Poupança mostra o PROGRAMADO (com fallback ?? 0) —
    // nunca some e nunca fica "R$ 0,00" com plano cadastrado
    expect(src).toContain('formatBRL(savingsSum?.programadoCents ?? 0)');
  });

  test('getMonthOverview NUNCA volta null — sem plano devolve zeros (não some)', async () => {
    const { services } = await ctx!;
    const ov = await services.savings.getMonthOverview(monthOf(todaySP()));
    expect(ov).not.toBeNull();
    expect(ov.entries).toEqual([]);
    expect(ov.plannedCents).toBe(0);
    expect(ov.effectedCents).toBe(0);
    expect(ov.remainingCents).toBe(0);
  });

  test('getMonthSummary sem orçamentos devolve zeros (não some)', async () => {
    const { services } = await ctx!;
    const sum = await services.budgets.getMonthSummary(monthOf(todaySP()));
    expect(sum.items).toEqual([]);
    expect(sum.budgetedCents).toBe(0);
    expect(sum.remainingCents).toBe(0);
  });
});

// ═══════════════════════════════ BUG 4 — Orçamento item ▸ subitem ═══════════════════════════════

describe('v67 BUG 4 — orçamento composto: pai R$ 100 = 60 + 40', () => {
  test('pai mostra a SOMA dos subitens; subitens ficam fora dos totais (sem dupla contagem)', async () => {
    const { services } = await ctx!;
    const pai = await services.categories.create({ name: 'Casa', direction: 'DEBIT' });
    const sub1 = await services.categories.create({ name: 'Cozinha', direction: 'DEBIT', parentId: pai.id });
    const sub2 = await services.categories.create({ name: 'Lavanderia', direction: 'DEBIT', parentId: pai.id });

    await services.budgets.save(pai.id, 10_000); // pai R$ 100
    await services.budgets.save(sub1.id, 6_000); // subitem R$ 60
    await services.budgets.save(sub2.id, 4_000); // subitem R$ 40

    // gastos: 15 na Cozinha + 10 na Lavanderia + 5 direto no pai
    const acc = await seedAccount(services.db);
    const mes = monthOf(todaySP());
    await services.transactions.createAccountExpense({ description: 'Feijão', amountCents: 1_500, accountId: acc, categoryId: sub1.id, date: `${mes}-05` });
    await services.transactions.createAccountExpense({ description: 'Sabão', amountCents: 1_000, accountId: acc, categoryId: sub2.id, date: `${mes}-06` });
    await services.transactions.createAccountExpense({ description: 'Hydra', amountCents: 500, accountId: acc, categoryId: pai.id, date: `${mes}-07` });

    const sum = await services.budgets.getMonthSummary(mes);
    const paiItem = sum.items.find((i) => i.categoryId === pai.id)!;
    const s1 = sum.items.find((i) => i.categoryId === sub1.id)!;
    const s2 = sum.items.find((i) => i.categoryId === sub2.id)!;

    // PAI COMPOSTO: valor = 60 + 40 = 100 (o próprio R$ 100 não soma por cima)
    expect(paiItem.composedFromSubs).toBe(true);
    expect(paiItem.amountCents).toBe(10_000);
    // gasto do pai = próprio + subitens
    expect(paiItem.spentCents).toBe(3_000);
    // SUBITENS: cada um com a barrinha dele, mas FORA dos totais
    expect(s1.partOfParent).toBe(true);
    expect(s2.partOfParent).toBe(true);
    expect(s1.parentBudgetId).toBe(paiItem.budgetId);
    // TOTAIS contam o pai UMA vez — nunca 200 nem 220
    expect(sum.budgetedCents).toBe(10_000);
    expect(sum.spentCents).toBe(3_000);
    expect(sum.remainingCents).toBe(7_000);
  });

  test('excluir o item PERGUNTA o destino: só o item (subitens ficam) OU item + subitens', async () => {
    const { services } = await ctx!;
    const pai = await services.categories.create({ name: 'Mercado V67', direction: 'DEBIT' });
    const sub = await services.categories.create({ name: 'Hortifruti V67', direction: 'DEBIT', parentId: pai.id });
    await services.budgets.save(pai.id, 10_000);
    const paiBudget = (await services.budgets.list()).find((b) => b.category_id === pai.id)!;
    await services.budgets.save(sub.id, 4_000);

    // ONLY_THIS: só o pai sai; o subitem continua orçado (fica independente)
    const n1 = await services.budgets.removeWithStrategy(paiBudget.id, 'ONLY_THIS');
    expect(n1).toBe(1);
    let rows = await services.budgets.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].category_id).toBe(sub.id);

    // com o pai de volta, WITH_SUBITEMS leva o pai E os subitens
    await services.budgets.save(pai.id, 9_000);
    const paiBudget2 = (await services.budgets.list()).find((b) => b.category_id === pai.id)!;
    const n2 = await services.budgets.removeWithStrategy(paiBudget2.id, 'WITH_SUBITEMS');
    expect(n2).toBe(2); // pai + 1 subitem
    expect(await services.budgets.list()).toHaveLength(0);
  });

  test('subitem salva/edita/exclui o orçamento dele de forma independente', async () => {
    const { services } = await ctx!;
    const pai = await services.categories.create({ name: 'Pets', direction: 'DEBIT' });
    const sub = await services.categories.create({ name: 'Ração', direction: 'DEBIT', parentId: pai.id });
    await services.budgets.save(sub.id, 3_000);
    let rows = await services.budgets.list();
    expect(rows).toHaveLength(1);
    // editar (mesma categoria atualiza)
    await services.budgets.save(sub.id, 3_500);
    rows = await services.budgets.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_cents).toBe(3_500);
    // excluir só o subitem
    await services.budgets.remove(rows[0].id);
    expect(await services.budgets.list()).toHaveLength(0);
  });

  test('tela Orçamento oferece o diálogo com o destino dos subitens', () => {
    const src = fs.readFileSync(path.join(root, 'app', 'orcamento.tsx'), 'utf8');
    expect(src).toContain('removeWithStrategy');
    expect(src).toContain('Só o item — subitens ficam independentes');
    expect(src).toContain('Item + subitens');
    expect(src).toContain('(soma dos subitens)');
  });
});

// ═══════════════════════════════ BUG 5 — categorias por direção ═══════════════════════════════

describe('v67 BUG 5 — cada direção com a sua lista; trocar limpa a categoria', () => {
  test('categoryMatchesFilter: DEBIT não entra em CREDIT e vice-versa; BOTH entra nas duas', () => {
    expect(categoryMatchesFilter({ direction: 'DEBIT' }, 'DEBIT')).toBe(true);
    expect(categoryMatchesFilter({ direction: 'DEBIT' }, 'CREDIT')).toBe(false);
    expect(categoryMatchesFilter({ direction: 'CREDIT' }, 'CREDIT')).toBe(true);
    expect(categoryMatchesFilter({ direction: 'CREDIT' }, 'DEBIT')).toBe(false);
    expect(categoryMatchesFilter({ direction: 'BOTH' }, 'DEBIT')).toBe(true);
    expect(categoryMatchesFilter({ direction: 'BOTH' }, 'CREDIT')).toBe(true);
    // sem direção gravada = BOTH
    expect(categoryMatchesFilter({ direction: null }, 'CREDIT')).toBe(true);
    // ANY aceita tudo
    expect(categoryMatchesFilter({ direction: 'CREDIT' }, 'ANY')).toBe(true);
  });

  test('filterForKind: Despesa→DEBIT, Receita→CREDIT', () => {
    expect(filterForKind('EXPENSE')).toBe('DEBIT');
    expect(filterForKind('INCOME')).toBe('CREDIT');
    expect(filterForKind('TRANSFER')).toBe('ANY');
  });

  test('lancamento limpa a categoria ao trocar o tipo (formulário e linhas do grupo)', () => {
    const src = lancSrc();
    // formulário simples: efeito que limpa categoryId quando não pertence ao novo kind
    expect(src).toContain('v67 (BUG 5)');
    expect(src).toMatch(/setCategoryId\(\(cur\) => \{[\s\S]*?categoryMatchesFilter\(cat, dirFilter\) \? cur : null/);
    expect(src).toContain('}, [kind, categories]);');
    // linhas do consolidado: trocar Débito↔Crédito limpa a categoria da linha
    expect(src).toMatch(/onChange=\{\(v\) => \{\s*const cat = categories\.find\(\(c\) => c\.id === l\.categoryId\);[\s\S]*?categoryId: keep \? l\.categoryId : null/);
  });

  test('a lista gravada respeita a direção: receita não nasce com categoria de débito', async () => {
    const { services } = await ctx!;
    const deb = await services.categories.create({ name: 'Supermercado', direction: 'DEBIT' });
    const cred = await services.categories.create({ name: 'Salário', direction: 'CREDIT' });
    const acc = await seedAccount(services.db);
    // fluxo do formulário (com a limpeza do BUG 5): só categoria da direção certa chega ao serviço
    const inc = await services.transactions.createAccountIncome({
      description: 'Freela', amountCents: 5_000, accountId: acc, categoryId: cred.id, date: todaySP(),
    });
    expect(inc.category_id).toBe(cred.id);
    // e a categoria de débito NÃO apareceria na lista de crédito:
    expect(categoryMatchesFilter({ direction: deb.direction }, 'CREDIT')).toBe(false);
  });
});

// ═══════════════════════════════ BUG 6 — topo dos Cartões = próxima fatura ═══════════════════════════════

describe('v67 BUG 6 — topo do cartão = PRÓXIMA fatura em aberto (por cartão)', () => {
  test('a mais ANTIGA em aberto é a próxima (não a mais nova); pagas ficam de fora', async () => {
    const { services } = await ctx!;
    const acc = await seedAccount(services.db);
    const card = await seedCardFix(services, acc);
    // compras em jan e mar (duas faturas em aberto)
    await services.transactions.createCardExpense({ description: 'Compra Jan', amountCents: 10_000, date: '2026-01-03', cardId: card });
    await services.transactions.createCardExpense({ description: 'Compra Mar', amountCents: 20_000, date: '2026-03-05', cardId: card });

    const next1 = await services.invoices.getNextOpenInvoice(card);
    expect(next1).not.toBeNull();
    expect(next1!.invoice.reference_month).toBe('2026-01'); // a próxima a pagar
    expect(next1!.dueCents).toBe(10_000);

    // paga a de janeiro → a próxima passa a ser a de março
    await services.invoices.payInvoice({ invoiceId: next1!.invoice.id, fromAccountId: acc, amountCents: 10_000 });
    const next2 = await services.invoices.getNextOpenInvoice(card);
    expect(next2!.invoice.reference_month).toBe('2026-03');

    // paga a de março → sem fatura em aberto
    await services.invoices.payInvoice({ invoiceId: next2!.invoice.id, fromAccountId: acc, amountCents: 20_000 });
    const next3 = await services.invoices.getNextOpenInvoice(card);
    expect(next3).toBeNull();
  });

  test('cada cartão tem a sua próxima fatura (independentes)', async () => {
    const { services } = await ctx!;
    const acc = await seedAccount(services.db);
    const cardA = await seedCardFix(services, acc, 'Cartão A', 15, 10);
    const cardB = await seedCardFix(services, acc, 'Cartão B', 20, 5);
    await services.transactions.createCardExpense({ description: 'Só no A', amountCents: 5_000, date: '2026-02-10', cardId: cardA });
    const nextA = await services.invoices.getNextOpenInvoice(cardA);
    const nextB = await services.invoices.getNextOpenInvoice(cardB);
    expect(nextA).not.toBeNull();
    expect(nextA!.dueCents).toBe(5_000);
    expect(nextB).toBeNull(); // cartão B não herda a fatura do A
  });

  test('telas: lista e detalhe mostram R$ 0,00 · "Sem fatura em aberto" e usam getNextOpenInvoice', () => {
    const list = fs.readFileSync(path.join(root, 'app', 'cartoes.tsx'), 'utf8');
    const det = fs.readFileSync(path.join(root, 'app', 'cartoes', '[id].tsx'), 'utf8');
    expect(list).toContain('getNextOpenInvoice');
    expect(list).toContain('Sem fatura em aberto');
    expect(list).toContain('formatBRL(0)');
    expect(det).toContain('getNextOpenInvoice');
    expect(det).toContain('Próxima fatura em aberto');
    expect(det).toContain('Sem fatura em aberto');
    expect(det).toContain('formatBRL(nextOpen?.dueCents ?? 0)');
  });
});

// ═══════════════════════════════ MELHORIA 1 — NFC-e guiado item a item ═══════════════════════════════

describe('v67 MELHORIA 1 — fluxo guiado: EAN → Alias → Fuzzy → novo → estoque', () => {
  test('resolução na ordem da tabela da verdade e produto novo CLASSIFICADO NA HORA', async () => {
    const { services } = await ctx!;
    // produto com EAN já catalogado (passo 1)
    await services.products.createManualProduct({ name: 'Leite Integral 1L', ean: '7896102500110', baseUnit: 'UN' });
    // produto parecido para a SUGESTÃO fuzzy (passo 3 — só sugere, nunca une)
    const mamao = await services.products.createManualProduct({ name: 'MAMÃO PAPAYA', baseUnit: 'G' });

    const key = genKey();
    await ingest(key, notaHtml('SENDAS DISTRIBUIDORA S/A', CNPJ_ASSAI,
      itemRow('LEITE INTEGRAL 1L', '7896102500110', '1', 'UN', '5,99', '5,99') +
      itemRow('MAMAO PAPAYA kg', '8142', '1,000', 'Kg', '5,89', '5,89') +
      itemRow('BOLACHA RECHEADA TOTALMENTE XPTO', '999', '2', 'UN', '3,50', '7,00'),
    ));
    const rows = await itemsOf(key);
    expect(rows).toHaveLength(3);

    // 1) EAN exato (código de 13 dígitos) → auto, sem perguntar
    const leite = rows.find((r) => r.ean_extracted === '7896102500110')!;
    expect(leite.match_type).toBe('EAN');
    expect(leite.product_id).not.toBeNull();

    // 3) fuzzy → SÓ SUGESTÃO (match FUZZY, decisão do usuário)
    const fuzzy = rows.find((r) => r.description === 'MAMAO PAPAYA kg')!;
    expect(fuzzy.match_type).toBe('FUZZY');

    // 4) desconhecido → NOVO
    const novo = rows.find((r) => r.description === 'BOLACHA RECHEADA TOTALMENTE XPTO')!;
    expect(novo.match_type).toBe('NEW');

    // MELHORIA 1: novo produto CLASSIFICADO NA HORA com categoria de DÉBITO
    const cat = await services.categories.create({ name: 'Mercearia', direction: 'DEBIT' });
    const prodId = await services.nfce.createProductFromItem(novo.id, cat.id);
    const prod = await services.products.getProduct(prodId);
    expect(prod!.category_id).toBe(cat.id);
    expect(prod!.name).toBe('BOLACHA RECHEADA TOTALMENTE XPTO');

    // decisão grava o alias (CNPJ, código) — a próxima nota da loja resolve no passo 2
    const key2 = genKey();
    await ingest(key2, notaHtml('SENDAS DISTRIBUIDORA S/A', CNPJ_ASSAI,
      itemRow('BOLACHA RECHEADA TOTALMENTE XPTO', '999', '1', 'UN', '3,50', '3,50'),
    ));
    const rows2 = await itemsOf(key2);
    expect(rows2[0].match_type).toBe('ALIAS'); // aprendido
    expect(rows2[0].product_id).toBe(prodId);
    void mamao; void leite;
  });

  test('"Incluir no estoque?" — SIM aplica; "Apenas agora" deixa fora; "Sempre" grava NUNCA', async () => {
    const { services } = await ctx!;
    const key = genKey();
    await ingest(key, notaHtml('EMPORIO A FRUTAS', '45.723.174/0001-10',
      itemRow('ABACAXI PERA', '777', '1', 'UN', '5,89', '5,89'),
    ));
    const rows = await itemsOf(key);
    const item = rows[0];
    expect(item.match_type).toBe('NEW');

    // produto criado na revisão (classificado com categoria de débito)
    const cat = await services.categories.create({ name: 'Frutas', direction: 'DEBIT' });
    const prodId = await services.nfce.createProductFromItem(item.id, cat.id);

    // "Apenas agora" → fora do estoque (só nesta nota)
    await services.nfce.ignoreItem(item.id);
    const aplicados = await services.pantry.applyNfceItems(key);
    expect(aplicados).toBe(0);
    let pantry = await services.pantry.listPantry();
    expect(pantry.find((p: any) => p.product_id === prodId)).toBeUndefined();

    // "Sempre" → pantry_policy NUNCA gravada no produto (próximas notas nem perguntam)
    await services.products.setPantryPolicy(prodId, 'NEVER');
    const prod = await services.products.getProduct(prodId);
    expect(prod!.pantry_policy).toBe('NEVER');
  });

  test('SIM incluir: confirmar a decisão aplica o estoque do item', async () => {
    const { services } = await ctx!;
    const key = genKey();
    await ingest(key, notaHtml('EMPORIO A FRUTAS', '45.723.174/0001-10',
      itemRow('BANANA PRATA', '555', '1,500', 'Kg', '4,50', '6,75'),
    ));
    const rows = await itemsOf(key);
    const cat = await services.categories.create({ name: 'Horti', direction: 'DEBIT' });
    const prodId = await services.nfce.createProductFromItem(rows[0].id, cat.id);
    // confirmar (É esse / Sim) → vai para o estoque na unidade da NF (KG → G, sem conversão inventada)
    await services.nfce.confirmItemProduct(rows[0].id);
    const pantry = await services.pantry.listPantry();
    const row = pantry.find((p: any) => p.product_id === prodId)!;
    expect(row).toBeDefined();
    expect(row.quantity_base).toBe(1500); // 1,5 kg = 1500 g
  });

  test('tela: botões guiados "É esse / É outro / + Produto novo / Ignorar" e pergunta do estoque', () => {
    const src = nfceSrc();
    expect(src).toContain('É esse (');
    expect(src).toContain('É outro');
    expect(src).toContain('+ Produto novo');
    expect(src).toContain('Incluir no estoque?');
    expect(src).toContain('Apenas agora (fica fora)');
    expect(src).toContain('Sempre (NUNCA perguntar)');
    // classificação inline com categorias de DÉBITO
    expect(src).toContain("c.direction !== 'CREDIT'");
    expect(src).toContain('CategoriaSelect cats={cats}');
  });
});

// ═══════════════════════════════ MELHORIA 2 — Catálogo de Produto ═══════════════════════════════

describe('v67 MELHORIA 2 — Catálogo de Produto: excluir SÓ DESVINCULA', () => {
  test('excluir tira do catálogo; notas ficam (product_id NULL); lançamentos intactos', async () => {
    const { services, db } = await ctx!;
    const prod = await services.products.createManualProduct({ name: 'Arroz Tipo 1', baseUnit: 'UN' });

    // nota com item vinculado ao produto (decisão manual)
    const key = genKey();
    await ingest(key, notaHtml('EMPORIO A FRUTAS', '45.723.174/0001-10',
      itemRow('ARROZ TIPO 1 PACOTE', '777', '1', 'UN', '5,89', '5,89'),
    ));
    const rows = await itemsOf(key);
    await services.nfce.linkItemToProduct(rows[0].id, prod.id);

    // aprendizado (alias) + estoque/despensa
    await services.products.recordDecision(prod.id, { storeName: 'EMPORIO A FRUTAS', storeProductCode: '777' });
    await services.pantry.registerManualMovement({ productId: prod.id, deltaBase: 3, reason: 'CORRECTION' });

    // um lançamento financeiro qualquer — NUNCA é afetado
    const acc = await seedAccount(services.db);
    const tx = await services.transactions.createAccountExpense({ description: 'Compra do arroz', amountCents: 1_234, accountId: acc, date: todaySP() });
    const txCountBefore = (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions'))!.n;

    const res = await services.products.removeCatalogProduct(prod.id);
    expect(res.itemsUnlinked).toBe(1);

    // catálogo sem o produto
    const list = await services.products.listProducts();
    expect(list.find((p: any) => p.id === prod.id)).toBeUndefined();

    // NOTA PRESERVADA: item continua lá, só sem vínculo
    const rowsAfter = await itemsOf(key);
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].description).toBe('ARROZ TIPO 1 PACOTE');
    expect(rowsAfter[0].product_id).toBeNull();

    // aprendizado sai junto (pertencia ao produto)
    const aliasCount = (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM product_aliases WHERE product_id = ?', [prod.id]))!.n;
    expect(aliasCount).toBe(0);
    // estoque/despensa do produto saem junto
    const pantry = await services.pantry.listPantry();
    expect(pantry.find((p: any) => p.product_id === prod.id)).toBeUndefined();

    // LANÇAMENTOS INTACTOS
    const txCountAfter = (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM transactions'))!.n;
    expect(txCountAfter).toBe(txCountBefore);
    const stillThere = await db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [tx.id]);
    expect(stillThere).not.toBeNull();
  });

  test('menu do Cadastro tem "Catálogo de Produto" e a lista não mostra EAN', () => {
    const cad = fs.readFileSync(path.join(root, 'app', 'cadastro.tsx'), 'utf8');
    expect(cad).toContain('Catálogo de Produto');
    expect(cad).toContain("href: '/produtos'");
    const prod = fs.readFileSync(path.join(root, 'app', 'produtos.tsx'), 'utf8');
    expect(prod).toContain('title="Catálogo de Produto"');
    expect(prod).not.toMatch(/EAN \$\{p\.ean\}|Sem EAN/); // EAN fora da lista (fica no banco)
    // v68: a lista é SÓ visualização — editar/excluir acontecem na TELA DE
    // EDIÇÃO (/produtos/[id]); os controles −1/+1/Lixeira são da Despensa.
    const edit = fs.readFileSync(path.join(root, 'app', 'produtos', '[id].tsx'), 'utf8');
    expect(edit).toContain('removeCatalogProduct');
    expect(edit).toContain('Excluir do catálogo?');
    expect(prod).not.toContain('removeCatalogProduct');
  });
});

// ═══════════════════════════════ MELHORIA 3 — blocos fora do Fluxo ═══════════════════════════════

describe('v67 MELHORIA 3 — Recorrência/Parcelamentos fora da TELA Fluxo (dados intactos)', () => {
  test('fluxo.tsx não tem mais os atalhos; dados/lógica de ocorrências e parcelas permanecem', () => {
    const src = fluxoSrc();
    expect(src).not.toContain("router.push('/parcelamentos')");
    expect(src).not.toContain("router.push('/recorrencias')");
    // os LANÇAMENTOS continuam: faturas, parcelas em conta e ocorrências na lista do mês
    expect(src).toContain('listAccountInstallmentsDueInMonth');
    expect(src).toContain('renderInstallmentRow');
    expect(src).toContain('listInvoicesDueInMonth');
    expect(src).toContain('ensureForecastThrough');
    // telas seguem existindo (acessíveis pela Home)
    expect(fs.existsSync(path.join(root, 'app', 'recorrencias.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'app', 'parcelamentos.tsx'))).toBe(true);
  });

  test('REGRESSÃO: conta fixa criada continua nascendo no mês (lógica preservada)', async () => {
    const { services } = await ctx!;
    const acc = await seedAccount(services.db);
    await services.recurrences.createRule({
      description: 'Aluguel', type: 'EXPENSE', amountCents: 120_00,
      dayOfMonth: 5, startDate: '2026-01-01', accountId: acc,
    });
    const res = await services.recurrences.runDueRecurrences();
    expect(res.createdTransactions).toBeGreaterThan(0);
    const flow = await services.transactions.listFlow('2026-01');
    const aluguel = (flow as any[]).filter((t) => t.description === 'Aluguel');
    expect(aluguel.length).toBeGreaterThan(0);
  });
});

// ───────────────────────── helpers locais ─────────────────────────

async function seedCardFix(
  services: NonNullable<typeof ctx>['services'],
  accountId: string,
  name = 'Cartão V67',
  closingDay = 15,
  dueDay = 10,
): Promise<string> {
  const id = `card-v67-${Math.random().toString(36).slice(2, 8)}`;
  await services.db.runAsync(
    'INSERT INTO cards (id, name, last_four_digits, closing_day, due_day, linked_account_id) VALUES (?,?,?,?,?,?)',
    [id, name, '4321', closingDay, dueDay, accountId]
  );
  return id;
}
