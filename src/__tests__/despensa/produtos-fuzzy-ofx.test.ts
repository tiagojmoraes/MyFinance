/** v56/v100 — FUZZY: para PRODUTO funciona (tokens); para OFX saiu da resolução.
 *
 *  v56 perguntava "fuzzy funciona?": para PRODUTO, sim — productSimilarity
 *  por tokens (v37). Na v100 o passo fuzzy SAIU da resolução (NF e OFX):
 *  memoSimilarity, isFuzzyMatch e matchOfxLineWithMemo foram removidos. O
 *  item parecido cai nos Pendentes do Catálogo e a semelhança aparece como
 *  SUGESTÃO na tela "＋ Criar produto" (suggestTop3). O casamento de OFX
 *  ficou determinístico: data + valor (matchOfxLine), empate → AMBIGUOUS.
 */
import { productSimilarity } from '../../lib/text';
import { matchOfxLine } from '../../lib/ofxMatch';

describe('v56 FUZZY PRODUTO — SIM, funciona (tokens)', () => {
  const iguais = [
    { a: 'LEITE INTEGRAL CAIXA 1L', b: 'Leite Integral Caixa 1L' },
    { a: 'CAFE PILAO 500G', b: 'Café Pilão 500g' },
    { a: 'MAMAO PAPAYA KG', b: 'Mamão Papaya' },
  ];
  test.each(iguais)('Produto igual normalizado → AUTO: $a ≈ $b', ({ a, b }) => {
    expect(productSimilarity(a, b)).toBeGreaterThanOrEqual(0.94);
  });
  test('Produto diferente, mesmo gênero -> NÃO unifica (é o ponto do fuzzy bom)', () => {
    expect(productSimilarity('MANGA PALMER', 'MANGA TOMMY')).toBeLessThan(0.84);
    expect(productSimilarity('ARROZ BRANCO', 'Arroz Integral')).toBeLessThan(0.84);
    expect(productSimilarity('BANANA PRATA KG', 'Banana Nanica KG')).toBeLessThan(0.84);
    expect(productSimilarity('LEITE', 'Leite Condensado')).toBeLessThan(0.84);
  });
  test('Produto diferente total -> NEW', () => {
    expect(productSimilarity('ARROZ', 'Feijão')).toBeLessThan(0.5);
    expect(productSimilarity('SABONETE DOVE', 'Pipoca Microondas')).toBeLessThan(0.5);
  });
  test('Produto quase igual -> ASK (pergunta, não unifica sozinho)', () => {
    const s = productSimilarity('ARROZ BRANCO 5KG TIPO 1', 'Arroz Branco 5 kg');
    expect(s).toBeGreaterThanOrEqual(0.84); expect(s).toBeLessThan(0.94);
  });
});

describe('v100 OFX — casamento determinístico por data + valor (matchOfxLine)', () => {
  const mesmosValores = [
    { id: 'a', amountCents: 5000, occurredOn: '2026-11-04', type: 'EXPENSE' as const, description: 'Mercado' },
    { id: 'b', amountCents: 5000, occurredOn: '2026-11-06', type: 'EXPENSE' as const, description: 'Farmácia' },
  ];
  test.each([
    {
      desc: 'Data+valor decidem: único candidato casa (memo de banco sujo é irrelevante)',
      line: { fitid: '1', postedOn: '2026-11-05', amountCents: -7500, memo: 'SUPERMERCADO XYZ LOJA 123' },
      existing: [{ id: 't1', amountCents: 7500, occurredOn: '2026-11-05', type: 'EXPENSE' as const, description: 'Mercado da esquina' }],
      status: 'MATCHED_AUTO', txId: 't1',
    },
    {
      desc: '2+ candidatos empatados → AMBIGUOUS (usuário decide, não amarra sozinho)',
      line: { fitid: '2', postedOn: '2026-11-05', amountCents: -5000, memo: 'MERCADO' },
      existing: mesmosValores,
      status: 'AMBIGUOUS', txId: null,
    },
    {
      desc: 'Sem candidato com valor/data → NEW_TX (memo sozinho NUNCA cria match)',
      line: { fitid: '3', postedOn: '2026-11-05', amountCents: -7500, memo: 'Mercado' },
      existing: [{ id: 't1', amountCents: 7501, occurredOn: '2026-11-05', type: 'EXPENSE' as const, description: 'Mercado' }],
      status: 'NEW_TX', txId: null,
    },
  ])('$desc', ({ line, existing, status, txId }) => {
    const r = matchOfxLine(line, existing);
    expect(r.status).toBe(status);
    expect(r.txId).toBe(txId);
  });
});
