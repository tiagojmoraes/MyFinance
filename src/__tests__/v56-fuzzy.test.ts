/** v56 — FUZZY MATCHING: funciona? Resposta: PRODUTO sim, OFX não (sozinho).
 *  Roda: npm run test:bateria56 | .\scripts\run-bateria.ps1 -Bateria56
 */
import { memoSimilarity, productSimilarity, isFuzzyMatch, normalizeText } from '../lib/text';
import { matchOfxLineWithMemo } from '../lib/ofxMatch';

describe('v56 FUZZY PRODUTO — SIM, funciona (tokens)', () => {
  test('Produto igual, loja diferente -> AUTO', () => {
    expect(productSimilarity('LEITE INTEGRAL CAIXA 1L', 'Leite Integral Caixa 1L')).toBeGreaterThanOrEqual(0.94);
    expect(productSimilarity('CAFE PILAO 500G', 'Café Pilão 500g')).toBeGreaterThanOrEqual(0.94);
    expect(productSimilarity('MAMAO PAPAYA KG', 'Mamão Papaya')).toBeGreaterThanOrEqual(0.94);
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

describe('v56 FUZZY OFX — NÃO funciona sozinho (memo é sujo)', () => {
  test('FALSO POSITIVO: MERCADO vs FEIJÃO dá 0.64 — se fosse threshold 0.5, amarraria errado', () => {
    const s = memoSimilarity('MERCADO', 'Feijão');
    expect(s).toBeGreaterThan(0.5); // prova o bug: coisas diferentes com score alto
    expect(s).toBeLessThan(0.9);
  });
  test('FALSO NEGATIVO: FARMACIA DROGASIL vs Drogasil dá só 0.47 — perderia o match certo', () => {
    expect(memoSimilarity('FARMACIA DROGASIL', 'Drogasil')).toBeLessThan(0.5);
  });
  test('Memo do banco tem lixo: SUPERMERCADO XYZ LOJA 123 vs Mercado = 0.69 (não é 1.0)', () => {
    const s = memoSimilarity('SUPERMERCADO XYZ LOJA 123', 'Mercado');
    expect(s).toBeGreaterThan(0.5); expect(s).toBeLessThan(0.9);
  });
  test('Memo curto é ambíguo: UBER vs Uber Eats = 0.89 (quase igual, mas é outro serviço)', () => {
    expect(memoSimilarity('UBER', 'Uber Eats')).toBeGreaterThan(0.8);
  });
  test('Memo bom funciona: UBER *EATS vs Uber Eats, IFOOD vs iFood', () => {
    expect(memoSimilarity('UBER *EATS', 'Uber Eats')).toBeGreaterThan(0.9);
    expect(memoSimilarity('IFOOD', 'iFood')).toBe(1);
  });
  test('isFuzzyMatch (threshold 0.90/0.92) é MUITO restritivo para OFX', () => {
    // isFuzzyMatch("SUPERMERCADO XYZ...","Mercado") = false, mesmo sendo o mesmo lugar
    expect(isFuzzyMatch('SUPERMERCADO XYZ LOJA 123', 'Mercado')).toBe(false);
    expect(isFuzzyMatch('FARMACIA DROGASIL', 'Drogasil')).toBe(false);
    // Mas para produto idêntico funciona
    expect(isFuzzyMatch('LEITE INTEGRAL 1L', 'LEITE INTEGRAL 1L')).toBe(true);
  });
});

describe('v56 FIX — memo só DESEMPATA, nunca decide', () => {
  test('Data+valor decidem, memo não precisa: Mercado vs Mercado da esquina casa', () => {
    const r = matchOfxLineWithMemo({ fitid: '1', postedOn: '2026-11-05', amountCents: -7500, memo: 'SUPERMERCADO XYZ LOJA 123' }, [{ id: 't1', amountCents: 7500, occurredOn: '2026-11-05', type: 'EXPENSE', description: 'Mercado da esquina' }]);
    expect(r.status).toBe('MATCHED_AUTO'); expect(r.txId).toBe('t1');
  });
  test('Ambíguo por data, memo desempata: 2x R$50, um é Mercado, outro é Farmácia', () => {
    const r = matchOfxLineWithMemo({ fitid: '1', postedOn: '2026-11-05', amountCents: -5000, memo: 'SUPERMERCADO XYZ' }, [
      { id: 'a', amountCents: 5000, occurredOn: '2026-11-04', type: 'EXPENSE', description: 'Mercado' },
      { id: 'b', amountCents: 5000, occurredOn: '2026-11-06', type: 'EXPENSE', description: 'Farmácia' },
    ]);
    // Memo de mercado é mais perto de "Mercado" que de "Farmácia" -> desempata para 'a'
    expect(r.status).toBe('MATCHED_AUTO'); expect(r.txId).toBe('a');
  });
  test('Ambíguo por data, memo NÃO desempata se os dois forem parecidos -> continua AMBIGUOUS', () => {
    const r = matchOfxLineWithMemo({ fitid: '1', postedOn: '2026-11-05', amountCents: -5000, memo: 'MERCADO' }, [
      { id: 'a', amountCents: 5000, occurredOn: '2026-11-04', type: 'EXPENSE', description: 'Mercado' },
      { id: 'b', amountCents: 5000, occurredOn: '2026-11-06', type: 'EXPENSE', description: 'Mercado' },
    ]);
    // Os dois têm a mesma descrição -> memo não ajuda -> AMBIGUOUS (certo: usuário decide)
    expect(r.status).toBe('AMBIGUOUS');
  });
  test('Memo sozinho NUNCA cria match: valor diferente + memo igual -> NEW_TX', () => {
    const r = matchOfxLineWithMemo({ fitid: '1', postedOn: '2026-11-05', amountCents: -7500, memo: 'Mercado' }, [{ id: 't1', amountCents: 7501, occurredOn: '2026-11-05', type: 'EXPENSE', description: 'Mercado' }]);
    expect(r.status).toBe('NEW_TX');
  });
});
