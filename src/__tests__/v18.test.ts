/**
 * Testes v18 — 6 bugs do lote atual:
 *  · Bug 1: alterar a DATA do Consolidado é aplicada de verdade e reflete no
 *    Fluxo de imediato (cabeçalho, linhas e movimentos reposicionados).
 *  · Bug 2: exclusão de parcela sai do Fluxo E do "Fluxo mensal (caixa)" na
 *    hora — a visão dual não lista mais parcelas canceladas; o movimento da
 *    conta é apagado fisicamente (mesma regra da exclusão pelo Fluxo).
 *  · Bug 3: saldo do dia Previsto/Efetivado — rotina reescrita, sem cache,
 *    recomputada a cada chamada: incluir/alterar/excluir/trocar status
 *    muda os números na leitura seguinte; escopo = só contas ativadas
 *    ("Aparecer no saldo do Fluxo").
 *  · Bug 4: TODOS os botões "Excluir" funcionam sem erro — os três pontos de
 *    FK que estouravam "FOREIGN KEY constraint failed" foram corrigidos:
 *    (a) "Excluir este e as próximas" de CONTA FIXA NO CARTÃO;
 *    (b) excluir a ÚLTIMA linha de um grupo com fixa/parcelado vinculado;
 *    (c) apagar o cabeçalho de parcelamento com parcelas pendentes no cartão.
 *  · Bug 5: "Alterar" no parcelamento abre a EDIÇÃO direta do plano
 *    (parâmetro ?plan= na tela Parcelamentos) — validado no contrato do
 *    roteamento via marcador de arquivo (app/fluxo.tsx / app/parcelamentos.tsx).
 *  · Bug 6: NFC-e — chave/URL do QR Code, extração do header (estabelecimento,
 *    CNPJ, totais) e dos itens (nome, código, qtde, un, total) sobre a página
 *    da SEFAZ-SP; migração v10 (cnpj + source_url).
 *  · Melhoria 1: cabeçalho do consolidado SEM marcadores Fixo/Parcelado —
 *    os marcadores ficam exclusivamente nos itens internos.
 */

import { makeCtx, seedAccount, seedCard } from './helpers';
import { buildGroupMonths, type FlowTx } from '../lib/flowModel';
import {
  extractAccessKey,
  listConsultUrls,
  buildSpConsultUrl,
  parseNfceHeader,
  parseNfceItems,
  normalizeCnpj,
  isSefazUrl,
} from '../parsers/nfce';

let ctx: ReturnType<typeof makeCtx> extends Promise<infer T> ? T : never;

beforeEach(async () => {
  ctx = await makeCtx();
});

/* ================================================================
 * BUG 1 — DATA do CONSOLIDADO aplicada e refletida no Fluxo
 * ================================================================ */
describe('Bug 1 — alterar data do consolidado reflete de imediato no Fluxo', () => {
  test('updateGroupHeader reposiciona cabeçalho, linhas e movimentos para o novo dia', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta Grupo', 1_000_00);
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Feira + farmácia',
      date: '2026-10-15',
      accountId: acc,
      lines: [{ direction: 'DEBIT', description: 'Feira', amountCents: 120_00, categoryId: null }],
      headerAmountCents: 120_00,
    });
    expect(grupo).toBeTruthy();

    await services.transactions.updateGroupHeader(grupo!.id, {
      description: 'Feira + farmácia (out/26)',
      date: '2026-11-05',
    });

    const header = await db.getFirstAsync<{ occurred_on: string; occurred_at: string; description: string }>(
      'SELECT occurred_on, occurred_at, description FROM transactions WHERE id = ?',
      [grupo!.id]
    );
    expect(header!.occurred_on).toBe('2026-11-05');
    expect(header!.occurred_at).toContain('2026-11-05');
    expect(header!.description).toBe('Feira + farmácia (out/26)');

    const child = await db.getFirstAsync<{ occurred_on: string }>(
      'SELECT occurred_on FROM transactions WHERE parent_transaction_id = ?',
      [grupo!.id]
    );
    expect(child!.occurred_on).toBe('2026-11-05');

    const move = await db.getFirstAsync<{ effective_date: string }>(
      `SELECT fm.effective_date FROM financial_moves fm
        JOIN transactions t ON t.id = fm.transaction_id
        WHERE t.parent_transaction_id = ?`,
      [grupo!.id]
    );
    expect(move!.effective_date).toBe('2026-11-05');

    // O card do grupo aparece NO NOVO MÊS na agregação do Fluxo
    const rowsNov = (await db.getAllAsync(
      `SELECT t.*, NULL AS plan_id, NULL AS plan_total_installments, NULL AS plan_paid_count,
              0 AS child_count, 0 AS group_debits_cents, 0 AS group_credits_cents
         FROM transactions t WHERE substr(t.occurred_on, 1, 7) = '2026-11'`
    )) as unknown as FlowTx[];
    const { gm } = await buildGroupMonths(db, '2026-11', rowsNov);
    expect(Object.keys(gm)).toContain(grupo!.id);
    expect(gm[grupo!.id].isHeaderMonth).toBe(true);

    // E NÃO aparece mais no mês antigo (saiu de outubro)
    const rowsOut = (await db.getAllAsync(
      `SELECT t.*, NULL AS plan_id, NULL AS plan_total_installments, NULL AS plan_paid_count,
              0 AS child_count, 0 AS group_debits_cents, 0 AS group_credits_cents
         FROM transactions t WHERE substr(t.occurred_on, 1, 7) = '2026-10'`
    )) as unknown as FlowTx[];
    const gmOut = await buildGroupMonths(db, '2026-10', rowsOut);
    expect(Object.keys(gmOut.gm)).not.toContain(grupo!.id);
  });
});

/* ================================================================
 * BUG 2 — EXCLUSÃO sincronizada com o "Fluxo mensal (caixa)"
 * ================================================================ */
describe('Bug 2 — parcela excluída sai do Fluxo E do Fluxo mensal (caixa)', () => {
  test('getDualView NÃO lista mais parcelas canceladas; movimento da conta é apagado', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta Parcelado', 5_000_00);
    const { planId } = await services.installments.createPlan({
      description: 'Obras 4x',
      mode: 'DIVIDE_TOTAL',
      totalCents: 400_00,
      totalInstallments: 4,
      firstDueDate: '2026-11-20',
      purchaseDate: '2026-11-01',
      accountId: acc,
    });

    const antes = await services.installments.getDualView(planId);
    expect(antes!.cashFlow).toHaveLength(4);

    // Exclusão "da parcela 2 em diante" (Fluxo) — cancela 2, 3, 4
    await services.installments.cancelFromSequence(planId, 2);

    const depois = await services.installments.getDualView(planId);
    // Fluxo mensal (caixa): só a parcela 1 permanece — as excluídas saem DE VEZ,
    // igual no Fluxo principal
    expect(depois!.cashFlow.map((c) => c.sequence)).toEqual([1]);
    // Custo total continua verdadeiro (pagas + restantes)
    expect(depois!.costReport.totalCents).toBe(100_00);

    // Movimento das parcelas EXCLUÍDAS: exclusão FÍSICA (não VOIDED, não fica nada)
    const movesCanceladas = await db.getAllAsync<{ id: string }>(
      `SELECT fm.id FROM financial_moves fm
        JOIN installments i ON i.id = fm.installment_id
        WHERE i.plan_id = ? AND i.status = 'CANCELED'`,
      [planId]
    );
    expect(movesCanceladas).toHaveLength(0);
    // A parcela que sobrou (1) mantém o movimento dela
    const movesRestantes = await db.getAllAsync<{ id: string }>(
      `SELECT fm.id FROM financial_moves fm
        JOIN installments i ON i.id = fm.installment_id
        WHERE i.plan_id = ? AND i.status != 'CANCELED'`,
      [planId]
    );
    expect(movesRestantes).toHaveLength(1);
  });

  test('excluir TODAS as parcelas em aberto (nenhuma paga) apaga plano e compra sem erro', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta Parcelado Zero', 5_000_00);
    const { planId, transactionId } = await services.installments.createPlan({
      description: 'Celular 3x',
      mode: 'DIVIDE_TOTAL',
      totalCents: 300_00,
      totalInstallments: 3,
      firstDueDate: '2026-11-25',
      purchaseDate: '2026-11-01',
      accountId: acc,
    });
    // era a fonte do erro "CHECK constraint failed: amount_cents > 0"
    await services.installments.cancelFromCurrent(planId, { onlyCurrent: false });
    expect(await db.getFirstAsync('SELECT id FROM installment_plans WHERE id = ?', [planId])).toBeNull();
    expect(await db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [transactionId])).toBeNull();
    const dual = await services.installments.getDualView(planId);
    expect(dual).toBeNull();
  });

  test('cancelFromSequence (Fluxo/fatura) também sincroniza os dois lugares', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta Parcelado 2', 5_000_00);
    const { planId } = await services.installments.createPlan({
      description: 'Móveis 6x',
      mode: 'FIXED_PER_MONTH',
      fixedAmountCents: 90_00,
      totalInstallments: 6,
      firstDueDate: '2026-12-10',
      purchaseDate: '2026-12-01',
      accountId: acc,
    });
    await services.installments.cancelFromSequence(planId, 3);
    const dual = await services.installments.getDualView(planId);
    expect(dual!.cashFlow.map((c) => c.sequence)).toEqual([1, 2]);
    expect(dual!.remainingCents).toBe(180_00);
  });
});

/* ================================================================
 * BUG 3 — SALDO DO DIA (Previsto/Efetivado): rotina robusta e garantida
 * ================================================================ */
describe('Bug 3 — saldo por dia recompensa CADA mudança (rotina sem cache)', () => {
  test('incluir, alterar e excluir lançamento muda os saldos na leitura seguinte', async () => {
    const { db, services } = ctx;
    await seedAccount(db, 'Conta Saldo', 1_000_00);

    const b1 = await services.balance.getDailyBalancesDual('2026-11');
    expect(b1.efetivado['2026-11-10']).toBe(1_000_00);
    expect(b1.previsto['2026-11-10']).toBe(1_000_00);

    // INCLUSÃO — despesa efetivada de 200 no dia 10
    // (v21: data futura nasce PENDING — a promoção força o efetivado para o teste)
    const tx = await services.transactions.createAccountExpense({
      description: 'Mercado',
      amountCents: 200_00,
      date: '2026-11-10',
      accountId: (await db.getAllAsync<{ id: string }>('SELECT id FROM accounts'))[0].id,
    });
    await services.transactions.promoteDuePendings('2026-11-10');
    const b2 = await services.balance.getDailyBalancesDual('2026-11');
    expect(b2.efetivado['2026-11-10']).toBe(800_00);

    // ALTERAÇÃO DE VALOR (300) — reflete na hora
    await services.transactions.updateSimple(tx.id, { amountCents: 300_00 });
    const b3 = await services.balance.getDailyBalancesDual('2026-11');
    expect(b3.efetivado['2026-11-10']).toBe(700_00);

    // TROCA DE STATUS → PENDING: sai do efetivado, ENTRA no previsto
    await services.transactions.setPaymentStatus(tx.id, false);
    const b4 = await services.balance.getDailyBalancesDual('2026-11');
    expect(b4.efetivado['2026-11-10']).toBe(1_000_00);
    expect(b4.previsto['2026-11-10']).toBe(700_00);

    // EXCLUSÃO — saldo volta ao inicial nos dois visões
    await services.transactions.deleteTransaction(tx.id);
    const b5 = await services.balance.getDailyBalancesDual('2026-11');
    expect(b5.efetivado['2026-11-10']).toBe(1_000_00);
    expect(b5.previsto['2026-11-10']).toBe(1_000_00);
  });

  test('escopo: apenas contas ativadas para o Fluxo (Aparecer no saldo = SIM)', async () => {
    const { db, services } = ctx;
    const fora = await seedAccount(db, 'Conta Fora', 5_000_00);
    const dentro = await seedAccount(db, 'Conta Dentro', 1_000_00);
    await db.runAsync('UPDATE accounts SET include_in_general_balance = 0 WHERE id = ?', [fora]);
    const dentroId = dentro;
    await services.transactions.createAccountExpense({
      description: 'Gasto na conta do escopo',
      amountCents: 150_00,
      date: '2026-11-05',
      accountId: dentroId,
    });
    // v21: data futura nasce PENDING — promoção força o efetivado para o teste
    await services.transactions.promoteDuePendings('2026-11-05');

    const bal = await services.balance.getDailyBalancesDual('2026-11');
    expect(bal.efetivado['2026-11-05']).toBe(850_00); // 1000 - 150 (a de fora fica fora)

    // Sem nenhuma conta no escopo: saldos zerados e estáveis
    await db.runAsync('UPDATE accounts SET include_in_general_balance = 0');
    const bal0 = await services.balance.getDailyBalancesDual('2026-11');
    expect(bal0.efetivado['2026-11-05']).toBe(0);
    expect(bal0.previsto['2026-11-05']).toBe(0);
  });
});

/* ================================================================
 * BUG 4 — ERROS AO EXCLUIR (FKs corrigidos em todos os botões Excluir)
 * ================================================================ */
describe('Bug 4 — exclusões de parcelados/fixos sem nenhum erro', () => {
  test('(a) "Excluir este e as próximas" de CONTA FIXA NO CARTÃO apaga sem FK', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta Cartão Fixa', 1_000_00);
    const card = await seedCard(db, acc, 'Cartão Fixa', 15, 10);
    const rule = await services.recurrences.createRule({
      description: 'Streaming fixo',
      type: 'EXPENSE',
      amountCents: 5_000,
      dayOfMonth: 5,
      startDate: '2026-10-05',
      cardId: card,
    });
    await services.recurrences.runDueRecurrences('2026-11-10');
    const occ = await db.getAllAsync<{ id: string; occurred_on: string }>(
      'SELECT id, occurred_on FROM transactions WHERE recurrence_rule_id = ?',
      [rule.id]
    );
    expect(occ.length).toBeGreaterThanOrEqual(1);
    // o item de fatura existe (a fixa entra na fatura do cartão)
    const itens = await db.getAllAsync('SELECT id FROM invoice_items WHERE transaction_id = ?', [occ[0].id]);
    expect(itens.length).toBeGreaterThanOrEqual(1);

    await services.recurrences.excludeFrom(rule.id, occ[0].occurred_on);

    const restantes = await db.getAllAsync('SELECT id FROM transactions WHERE recurrence_rule_id = ?', [rule.id]);
    expect(restantes).toHaveLength(0);
    // item da fatura sai junto e o total da fatura é recalculado
    const itensDepois = await db.getAllAsync('SELECT id FROM invoice_items WHERE transaction_id = ?', [occ[0].id]);
    expect(itensDepois).toHaveLength(0);
  });

  test('(b) excluir a ÚLTIMA linha de grupo com fixa vinculada não estoura FK', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta Grupo B', 2_000_00);
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Grupo misto B',
      date: '2026-11-01',
      accountId: acc,
      lines: [{ direction: 'DEBIT', description: 'Linha à vista', amountCents: 100_00, categoryId: null }],
      headerAmountCents: 100_00,
    });
    const fixa = await services.recurrences.createRule({
      description: 'Fixa do grupo B',
      type: 'EXPENSE',
      amountCents: 200_00,
      dayOfMonth: 10,
      startDate: '2026-11-10',
      accountId: acc,
      groupTransactionId: grupo!.id,
    });
    const child = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM transactions WHERE parent_transaction_id = ?',
      [grupo!.id]
    );
    await services.transactions.deleteTransaction(child!.id);
    expect(await db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [grupo!.id])).toBeNull();
    // a conta fixa sobrevive (vira independente)
    expect(await db.getFirstAsync('SELECT id FROM recurrence_rules WHERE id = ?', [fixa.id])).toBeTruthy();
  });

  test('(c) apagar parcelamento com parcelas pendentes em CARTÃO apaga sem FK', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta C', 3_000_00);
    const card = await seedCard(db, acc, 'Cartão C', 15, 10);
    const { planId, transactionId } = await services.installments.createPlan({
      description: 'Notebook 10x',
      mode: 'DIVIDE_TOTAL',
      totalCents: 5_000_00,
      totalInstallments: 10,
      firstDueDate: '2026-11-20',
      purchaseDate: '2026-11-01',
      cardId: card,
    });
    await services.transactions.deleteTransaction(transactionId);
    expect(await db.getFirstAsync('SELECT id FROM installment_plans WHERE id = ?', [planId])).toBeNull();
    // itens de fatura das parcelas pendentes saem e os totais são recalculados
    const itens = await db.getAllAsync('SELECT id FROM invoice_items WHERE installment_id IS NOT NULL');
    expect(itens).toHaveLength(0);
  });

  test('excluir GRUPO COMPLETO (deleteGroupDeep) com fixa + parcelado dentro funciona', async () => {
    const { db, services } = ctx;
    const acc = await seedAccount(db, 'Conta Deep', 4_000_00);
    const card = await seedCard(db, acc, 'Cartão Deep', 20, 12);
    const grupo = await services.transactions.createConsolidatedGroup({
      description: 'Operação completa',
      date: '2026-11-02',
      accountId: acc,
      lines: [{ direction: 'DEBIT', description: 'Compra à vista', amountCents: 50_00, categoryId: null }],
      headerAmountCents: 50_00,
    });
    await services.recurrences.createRule({
      description: 'Fixa dentro do grupo',
      type: 'EXPENSE',
      amountCents: 80_00,
      dayOfMonth: 8,
      startDate: '2026-11-08',
      accountId: acc,
      groupTransactionId: grupo!.id,
    });
    await services.installments.createPlan({
      description: 'Parcelado dentro do grupo',
      mode: 'DIVIDE_TOTAL',
      totalCents: 300_00,
      totalInstallments: 3,
      firstDueDate: '2026-11-15',
      purchaseDate: '2026-11-02',
      cardId: card,
      groupTransactionId: grupo!.id,
    });
    await services.recurrences.runDueRecurrences('2026-11-20');

    await services.transactions.deleteGroupDeep(grupo!.id);

    // cabeçalho e linhas fora; regra fora; parcelas pendentes fora
    expect(await db.getFirstAsync('SELECT id FROM transactions WHERE id = ?', [grupo!.id])).toBeNull();
    const regras = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM recurrence_rules WHERE group_transaction_id = ?',
      [grupo!.id]
    );
    const planos = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM installment_plans WHERE group_transaction_id = ?',
      [grupo!.id]
    );
    expect(regras!.n).toBe(0);
    expect(planos!.n).toBe(0);
  });
});

/* ================================================================
 * BUG 5 — "ALTERAR" DO PARCELAMENTO abre a edição direta do plano
 * ================================================================ */
describe('Bug 5 — roteamento do Alterar (parcela → edição do plano)', () => {
  test('v21: Fluxo e fatura abrem a TELA do plano (/plano/[id]); deep-link do Parcelamentos mantido', async () => {
    const fs = require('fs');
    const path = require('path');
    const fluxo = fs.readFileSync(path.join(__dirname, '../../app/fluxo.tsx'), 'utf8');
    expect(fluxo).toContain("pathname: '/plano/[id]', params: { id: tx.plan_id }");
    expect(fluxo).toContain("pathname: '/plano/[id]', params: { id: inst.planId }");
    expect(fs.existsSync(path.join(__dirname, '../../app/plano/[id].tsx'))).toBe(true);
    const par = fs.readFileSync(path.join(__dirname, '../../app/parcelamentos.tsx'), 'utf8');
    expect(par).toContain("useLocalSearchParams<{ plan?: string }>()");
    expect(par).toContain('openDual(target.id, target.description)');
    const fatura = fs.readFileSync(
      path.join(__dirname, '../../app/cartoes/[id]/fatura/[mes]/index.tsx'),
      'utf8'
    );
    expect(fatura).toContain("pathname: '/plano/[id]', params: { id: row?.plan_id ?? '' }");
  });
});

/* ================================================================
 * BUG 6 — NFC-e PONTA A PONTA (QR Code SEFAZ-SP)
 * ================================================================ */
describe('Bug 6 — NFC-e: URL do QR Code e extração obrigatória', () => {
  const CHAVE = '35250145543911000127650010000123451234567890';

  test('chave a partir da URL oficial do QR Code (com assinatura e pipes)', () => {
    const qr = `https://www.nfce.fazenda.sp.gov.br/qrcode?p=${CHAVE}|2|1|1|AB12cd34EF56gh78`;
    expect(extractAccessKey(qr)).toBe(CHAVE);
    expect(extractAccessKey(`https://www.nfce.fazenda.sp.gov.br/qrcode?p=${encodeURIComponent(`${CHAVE}|2|1|1|AB12`)}`)).toBe(CHAVE);
    expect(extractAccessKey(CHAVE)).toBe(CHAVE);
    expect(extractAccessKey('sem chave nenhuma')).toBeNull();
    expect(isSefazUrl(qr)).toBe(true);
  });

  test('candidatos de URL: v39.1 — canônico .br PRIMEIRO, QR escaneado de reserva, portal público no fim', () => {
    const qr = `https://www.nfce.fazenda.sp.gov.br/qrcode?p=${CHAVE}|2|1|1|AB12`;
    const urls = listConsultUrls(qr, CHAVE);
    // v39.1 (cupom Fonseca): o canal que FUNCIONA é o canônico — vai primeiro;
    // a URL do QR entra SANITIZADA (| → %7C) como reserva — o firewall rejeita
    // URL com caractere ilegal cru ("The requested URL was rejected")
    expect(urls[0]).toBe('https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=' + CHAVE + '%7C3%7C1');
    expect(urls[1]).toBe('https://www.nfce.fazenda.sp.gov.br/qrcode?p=' + CHAVE + '%7C2%7C1%7C1%7CAB12');
    expect(urls[2]).toBe(buildSpConsultUrl(CHAVE));
    // v32: o legado consultacompleta.aspx SAIU da fila (descontinuado — sem
    // resposta no PC e erro de certificado no celular)
    expect(urls.length).toBe(3);
    // chave manual: canônico primeiro, portal público depois
    const urlsManual = listConsultUrls(CHAVE, CHAVE);
    expect(urlsManual[0]).toBe(`https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${CHAVE}%7C3%7C1`);
    expect(urlsManual[1]).toBe(buildSpConsultUrl(CHAVE));
    expect(urlsManual[1]).toContain('NFCeConsultaPublica');
  });

  test('header: estabelecimento, CNPJ, emissão e totais (página SEFAZ-SP)', () => {
    const html = `
      <html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>
      <div class="accordion-body collapse in" id="collapse0">
        <table><tr><td class="info-titulo">Nome Empresarial:</td><td class="info-valor">SUPERMERCADO EXEMPLO LTDA</td></tr>
        <tr><td class="info-titulo">CNPJ:</td><td class="info-valor">45.543.911/0001-27</td></tr>
        <tr><td class="info-titulo">Data e Hora da Emissão:</td><td class="info-valor">01/11/2026 10:32:11</td></tr>
        </table>
      </div>
      <div class="row totais">
        <span class="label">Valor Total:</span><span class="text">R$ 187,43</span>
        <span class="label">Desconto:</span><span class="text">R$ 5,00</span>
        <span class="label">Valor Pago:</span><span class="text">R$ 187,43</span>
      </div></body></html>`;
    const h = parseNfceHeader(html, CHAVE);
    expect(h.storeName).toBe('SUPERMERCADO EXEMPLO LTDA');
    expect(h.cnpj).toBe('45.543.911/0001-27');
    expect(h.issuedAt).toContain('2026-11-01');
    expect(h.grossTotalCents).toBe(187_43);
    expect(h.amountPaidCents).toBe(187_43);
    expect(h.discountCents).toBe(5_00);
  });

  test('itens: nome do produto, código (GTIN/EAN e da loja), qtde, un e total', () => {
    const html = `
      <table class="tabela-itens">
      <tr><td>1</td><td><span>LEITE UHT INTEGRAL 1L</span></td><td>2 UN × R$ 4,99</td><td>R$ 9,98</td></tr>
      <tr><td colspan="9"><table>
        <tr><td>Código do produto (GTIN/EAN):</td><td>7896036098128</td></tr>
        <tr><td>Descrição:</td><td>LEITE UHT INTEGRAL 1L</td></tr>
        <tr><td>Qtde total de itens:</td><td>2,0000 UN</td></tr>
        <tr><td>Valor total do item:</td><td>R$ 9,98</td></tr>
      </table></td></tr>
      <tr><td>2</td><td><span>PÃO FRANCÊS KG</span></td><td>0,5000 KG × R$ 24,90</td><td>R$ 12,45</td></tr>
      <tr><td colspan="9"><table>
        <tr><td>Código do produto:</td><td>PAD-0042</td></tr>
        <tr><td>Qtde total de itens:</td><td>0,5000 KG</td></tr>
        <tr><td>Unidade comercial:</td><td>KG</td></tr>
        <tr><td>Valor total do item:</td><td>R$ 12,45</td></tr>
      </table></td></tr>
      </table>`;
    const items = parseNfceItems(html);
    expect(items.length).toBe(2);

    const [leite, pao] = items;
    expect(leite.description).toBe('LEITE UHT INTEGRAL 1L');
    expect(leite.eanExtracted).toBe('7896036098128');
    expect(leite.qty).toBe(2);
    expect(leite.unitOriginal).toBe('UN');
    expect(leite.totalCents).toBe(9_98);

    expect(pao.description).toBe('PÃO FRANCÊS KG');
    expect(pao.storeProductCode).toBe('PAD-0042');
    expect(pao.qty).toBeCloseTo(0.5, 6);
    expect(pao.unitOriginal).toBe('KG');
    expect(pao.totalCents).toBe(12_45);
  });

  test('normalização de CNPJ e migração v18 (cnpj + source_url)', async () => {
    expect(normalizeCnpj('45543911000127')).toBe('45.543.911/0001-27');
    expect(normalizeCnpj('45.543.911/0001-27')).toBe('45.543.911/0001-27');
    expect(normalizeCnpj('123')).toBeNull();

    const { db, services } = ctx;
    const cols = (await db.getAllAsync<{ name: string }>('PRAGMA table_info(nfce_documents)')).map((c) => c.name);
    expect(cols).toContain('cnpj');
    expect(cols).toContain('source_url');
    // documento novo aceita cnpj/source_url
    await services.db.runAsync(
      `INSERT INTO nfce_documents (access_key, store_name, cnpj, issued_at, amount_paid_cents, gross_total_cents,
        discount_cents, parse_status, needs_review, transaction_id, source_url)
       VALUES ('35250145543911000127650010000123451234567890','Loja Teste','45.543.911/0001-27',NULL,1000,1000,0,'COMPLETE',0,NULL,'https://www.nfce.fazenda.sp.gov.br/qrcode?p=x')`
    );
    const doc = await services.nfce.getDocument('35250145543911000127650010000123451234567890');
    expect(doc!.document.cnpj).toBe('45.543.911/0001-27');
    expect(doc!.document.source_url).toContain('qrcode?p=');
  });
});

/* ================================================================
 * MELHORIA 1 — CABEÇALHO do consolidado SEM Fixo/Parcelado
 * ================================================================ */
describe('Melhoria 1 — cabeçalho limpo; marcadores só nos itens internos', () => {
  test('fluxo.tsx: card do grupo não renderiza FixedDot/pill/kindLabel; filhos mantêm os marcadores', () => {
    const fs = require('fs');
    const path = require('path');
    const fluxo = fs.readFileSync(path.join(__dirname, '../../app/fluxo.tsx'), 'utf8');

    // recorte do card do grupo (renderGroupCard) — do comentário v18 até o amount
    const inicio = fluxo.indexOf('const renderGroupCard');
    const fim = fluxo.indexOf('const renderInvoiceCard');
    const grupo = fluxo.slice(inicio, fim);
    expect(grupo).not.toContain('<FixedDot />');
    expect(grupo).not.toContain('<InstallmentPill');
    expect(grupo).not.toContain('kindLabel');
    expect(grupo).toContain('CONSOLIDADO');

    // itens internos mantêm a iconografia padrão (renderTxCard)
    const txCard = fluxo.slice(fluxo.indexOf('const renderTxCard'), inicio);
    expect(txCard).toContain('<FixedDot />');
    expect(txCard).toContain('<InstallmentPill');

    // e as parcelas internas (renderInstallmentRow) mantêm a pill X/N
    const instRow = fluxo.slice(fluxo.indexOf('const renderInstallmentRow'), fluxo.indexOf('const renderEntry'));
    expect(instRow).toContain('<InstallmentPill');
  });

  test('parcela PAGA não oferece Excluir (evita o erro "Não há parcelas em aberto")', () => {
    const fs = require('fs');
    const path = require('path');
    const fluxo = fs.readFileSync(path.join(__dirname, '../../app/fluxo.tsx'), 'utf8');
    expect(fluxo).toContain('onExcluir: paid');
    expect(fluxo).toContain('pagas nunca são excluídas');
  });
});
