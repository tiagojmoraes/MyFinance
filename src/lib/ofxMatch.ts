/** v55 — Lógica de AMARRAÇÃO OFX x lançamentos existentes (sem tela).
 *  Regra do usuário: não usar local/estabelecimento. Só DATA + VALOR já são ótimo filtro.
 *  Funciona para DÉBITO e CRÉDITO, conta e cartão.
 *
 *  MATCH = mesmo valor absoluto (centavos) + mesma direção (débito/crédito)
 *          + data dentro da janela (±10 dias conta, ±5 dias cartão)
 *  Score = 1.0 se data exata, decai 0.1 por dia de distância. Desempate: menor |dias|.
 *  Se 2+ candidatos com mesmo score -> AMBIGUOUS (não amarra sozinho).
 */
export interface ExistingTx { id: string; amountCents: number; occurredOn: string; type: 'INCOME'|'EXPENSE'|'TRANSFER'; description: string | null; cardId?: string | null; accountId?: string | null; installmentId?: string | null; }
export interface OfxLineInput { fitid: string; postedOn: string; amountCents: number; memo: string; }
export type MatchResult = { status: 'MATCHED_AUTO'|'AMBIGUOUS'|'NEW_TX'; txId: string | null; score: number; candidates: ExistingTx[]; reason: string };

function absDays(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  return Math.abs(Math.round((da - db) / 86400000));
}
export function directionOf(amountCents: number): 'CREDIT'|'DEBIT' { return amountCents > 0 ? 'CREDIT' : 'DEBIT'; }
export function typeMatchesOfx(ofxAmount: number, txType: string): boolean {
  if (ofxAmount > 0) return txType === 'INCOME';
  return txType === 'EXPENSE' || txType === 'TRANSFER';
}
/** v55 — match principal. `windowDays` = 10 (conta) ou 5 (cartão). */
export function matchOfxLine(line: OfxLineInput, existing: ExistingTx[], windowDays = 10): MatchResult {
  const cands = existing.filter(tx => tx.amountCents === Math.abs(line.amountCents) && typeMatchesOfx(line.amountCents, tx.type) && absDays(line.postedOn, tx.occurredOn) <= windowDays);
  if (!cands.length) return { status: 'NEW_TX', txId: null, score: 0, candidates: [], reason: `Sem lançamento com valor ${Math.abs(line.amountCents)} e data ±${windowDays}d` };
  const scored = cands.map(tx => ({ tx, score: 1 - absDays(line.postedOn, tx.occurredOn) * 0.1 })).sort((a,b) => b.score - a.score);
  const best = scored[0]; const second = scored[1];
  if (!second || best.score - second.score >= 0.1) return { status: 'MATCHED_AUTO', txId: best.tx.id, score: best.score, candidates: cands, reason: `Data ${best.tx.occurredOn} a ${absDays(line.postedOn, best.tx.occurredOn)}d, valor igual` };
  return { status: 'AMBIGUOUS', txId: null, score: best.score, candidates: cands, reason: `2+ candidatos com mesmo score ${best.score.toFixed(2)}` };
}

/** v55 — PARCELAMENTO NO CARTÃO (a dúvida do usuário).
 *  Como o OFX do cartão mostra o parcelado:
 *  - Compra R$ 1.200 em 3x NÃO aparece como 1 linha de 1200. Aparece como 1 linha por mês, de R$ 400 cada, com FITID diferente.
 *  - Memo é igual todo mês ("Shopee 1/3", "Shopee 2/3" ou só "Shopee").
 *  Regra: a linha OFX casa com a PARCELA (installment), não com o plano inteiro.
 *  Se a parcela já existe na fatura (criada no lançamento parcelado), MATCHED_AUTO -> não cria nada, só marca a parcela como conciliada.
 *  Se a parcela NÃO existe (usuário não lançou o parcelado), NEW_TX -> cria item de fatura com installment_id = null + marca `is_installment_hint=true` para o usuário agrupar depois.
 *  Nunca criar 1 lançamento de R$ 1200 a partir de 3 linhas de R$ 400 — isso duplicaria.
 */
export interface InstallmentRow { id: string; sequenceNumber: number; totalInstallments: number; amountCents: number; dueDate: string; cardId: string; description: string; }
export function matchCardInstallment(line: OfxLineInput, installments: InstallmentRow[], windowDays = 5): { status: 'MATCHED_AUTO'|'AMBIGUOUS'|'NEW_TX'; installmentId: string | null; reason: string } {
  const cands = installments.filter(i => i.amountCents === Math.abs(line.amountCents) && absDays(line.postedOn, i.dueDate) <= windowDays);
  if (!cands.length) return { status: 'NEW_TX', installmentId: null, reason: 'Nenhuma parcela com esse valor e data' };
  const scored = cands.map(i => ({ i, d: absDays(line.postedOn, i.dueDate) })).sort((a,b) => a.d - b.d);
  if (scored.length > 1 && scored[0].d === scored[1].d) return { status: 'AMBIGUOUS', installmentId: null, reason: `2 parcelas com mesma distância ${scored[0].d}d` };
  return { status: 'MATCHED_AUTO', installmentId: scored[0].i.id, reason: `Parcela ${scored[0].i.sequenceNumber}/${scored[0].i.totalInstallments} a ${scored[0].d}d` };
}

/** v8 — o memo NÃO desempata mais (texto do extrato é sujo). Data+valor
 *  decidem; candidatos empatados na data ficam AMBIGUOUS e o usuário decide
 *  na tela de OFX. `matchOfxLine` é o único match (conta e cartão).
 */
