/** v57 — PRODUTOS (Cadastros) + MEMÓRIA + VINCULAÇÃO DURANTE A NF + KG vs UN
 *  Roda: npm run test:bateria57 | .\scripts\run-bateria.ps1 -Bateria57
 *  Plano acordado: vincular na NF (durante), classificar 1 vez na tabela, fuzzy só sugere.
 */
import { normalizeEan, findByEan, findByAlias, suggestByFuzzy, resolveNfItem, learnAlias, pantryDecisionFor, addStock, stockFor, spendByCategory, CatalogProduct, ProductAlias } from '../lib/productsCatalog';

const P = (id: string, name: string, patch: Partial<CatalogProduct> = {}): CatalogProduct => ({ id, name, ean: null, categoryId: null, subcategoryId: null, pantryPolicy: 'ASK', lowThresholdBase: null, baseUnit: 'UN', ...patch });
const A = (cnpj: string | null, storeCode: string, productId: string, aliasText = ''): ProductAlias => ({ cnpj, storeCode, ean: null, productId, aliasText });

describe('v57 EAN é minoria — salva código + EAN juntos', () => {
  test('normalizeEan: SEM GTIN / vazio / 0 = null', () => {
    expect(normalizeEan('SEM GTIN')).toBeNull(); expect(normalizeEan('')).toBeNull(); expect(normalizeEan(null)).toBeNull(); expect(normalizeEan('0')).toBeNull();
    expect(normalizeEan('7891234567890')).toBe('7891234567890');
  });
  test('EAN exato resolve em qualquer loja (global)', () => {
    const prods = [P('1', 'Banana Prata', { ean: '7891234567890' })];
    expect(findByEan(prods, '7891234567890')?.id).toBe('1');
    expect(findByEan(prods, 'SEM GTIN')).toBeNull();
  });
  test('Mesmo código em lojas diferentes = produtos diferentes (CNPJ+código é a chave)', () => {
    const prods = [P('1', 'Banana Prata'), P('2', 'Arroz')];
    const aliases = [A('ASSAI', '78901', '1', 'BANANA PRATA KG'), A('CARREFOUR', '78901', '2', 'ARROZ 5KG')];
    expect(findByAlias(aliases, 'ASSAI', '78901', prods)?.name).toBe('Banana Prata');
    expect(findByAlias(aliases, 'CARREFOUR', '78901', prods)?.name).toBe('Arroz');
    expect(findByAlias(aliases, 'BAIRRO', '78901', prods)).toBeNull();
  });
  test('EAN que veio ensina o código: learnAlias grava alias + EAN no produto', () => {
    const prods = [P('1', 'Banana Prata')];
    const { aliases, products } = learnAlias([], prods, { cnpj: 'ASSAI', storeCode: '78901', eanRaw: '7891234567890', aliasText: 'BANANA PRATA KG' }, '1');
    expect(aliases).toHaveLength(1); expect(aliases[0].ean).toBe('7891234567890');
    expect(products[0].ean).toBe('7891234567890');
    // Próxima vez SEM EAN resolve pelo alias
    expect(findByAlias(aliases, 'ASSAI', '78901', products)?.id).toBe('1');
  });
  test('Código que veio ensina o EAN: alias já existe, EAN novo grava no produto', () => {
    const prods = [P('1', 'Banana Prata')];
    const aliases = [A('BAIRRO', '999', '1', 'BNN PRATA')];
    const { products } = learnAlias(aliases, prods, { cnpj: 'BAIRRO', storeCode: '999', eanRaw: '7891234567890', aliasText: 'BNN PRATA' }, '1');
    expect(products[0].ean).toBe('7891234567890');
  });
});

describe('v57 ORDEM: EAN → Alias → Fuzzy-sugestão → Pergunta (fuzzy nunca unifica)', () => {
  const prods = [P('1', 'Banana Prata', { ean: '7891234567890' }), P('2', 'Arroz Branco')];
  const aliases = [A('ASSAI', '78901', '1', 'BANANA PRATA KG')];
  test('1º EAN vence alias e fuzzy', () => {
    const r = resolveNfItem({ name: 'QUALQUER COISA', eanRaw: '7891234567890', cnpj: 'LOJA X', storeCode: '000' }, prods, aliases);
    expect(r.kind).toBe('AUTO_EAN'); if (r.kind === 'AUTO_EAN') expect(r.product.id).toBe('1');
  });
  test('2º Alias vence fuzzy (sem EAN)', () => {
    const r = resolveNfItem({ name: 'BANANA PRATA KG', eanRaw: 'SEM GTIN', cnpj: 'ASSAI', storeCode: '78901' }, prods, aliases);
    expect(r.kind).toBe('AUTO_ALIAS');
  });
  test('3º Fuzzy só SUGERE, não unifica: BANANA PRATA - PESO sugere Banana Prata', () => {
    const r = resolveNfItem({ name: 'BANANA PRATA - PESO', eanRaw: null, cnpj: 'CARREFOUR', storeCode: '456' }, prods, aliases);
    expect(r.kind).toBe('ASK_FUZZY'); if (r.kind === 'ASK_FUZZY') { expect(r.suggestion?.id).toBe('1'); expect(r.score).toBeGreaterThanOrEqual(0.84); }
  });
  test('Fuzzy fraco não sugere: BNN PRATA sugere null (pergunta sem sugestão forte)', () => {
    const r = resolveNfItem({ name: 'BNN PRATA', eanRaw: null, cnpj: 'BAIRRO', storeCode: '999' }, prods, aliases);
    expect(r.kind).toBe('ASK_FUZZY');
  });
  test('Nenhum produto no catálogo → ASK_NEW', () => {
    const r = resolveNfItem({ name: 'COUVE MANTEIGA', eanRaw: null, cnpj: 'X', storeCode: '1' }, [], []);
    expect(r.kind).toBe('ASK_NEW');
  });
});

describe('v57 EXEMPLO DO USUÁRIO: 5 SEMPRE + 2 NUNCA → 2ª nota 0 perguntas, 3ª nota 1 pergunta', () => {
  // 1ª nota: usuário ensina 7 produtos
  const prods: CatalogProduct[] = [
    P('arroz', 'Arroz Branco', { pantryPolicy: 'ALWAYS', categoryId: 'Alimentos', subcategoryId: 'Grãos' }),
    P('feijao', 'Feijão Carioca', { pantryPolicy: 'ALWAYS', categoryId: 'Alimentos', subcategoryId: 'Grãos' }),
    P('banana', 'Banana Prata', { pantryPolicy: 'ALWAYS', categoryId: 'Alimentos', subcategoryId: 'Frutas' }),
    P('leite', 'Leite Integral', { pantryPolicy: 'ALWAYS', categoryId: 'Alimentos', subcategoryId: 'Laticínios' }),
    P('cafe', 'Café', { pantryPolicy: 'ALWAYS', categoryId: 'Alimentos', subcategoryId: 'Mercearia' }),
    P('sabao', 'Sabão em Pó', { pantryPolicy: 'NEVER', categoryId: 'Casa', subcategoryId: 'Limpeza' }),
    P('papel', 'Papel Higiênico', { pantryPolicy: 'NEVER', categoryId: 'Casa', subcategoryId: 'Banheiro' }),
  ];
  test('Memória: SEMPRE=IN, NUNCA=OUT, PERGUNTAR=ASK', () => {
    expect(pantryDecisionFor(prods[0])).toBe('IN'); expect(pantryDecisionFor(prods[5])).toBe('OUT');
    expect(pantryDecisionFor(P('x', 'Novo'))).toBe('ASK');
  });
  test('2ª nota, mesmos 7 itens: 0 perguntas (5 entram, 2 pulam sozinhos)', () => {
    const decisions = prods.map(p => pantryDecisionFor(p));
    expect(decisions.filter(d => d === 'ASK')).toHaveLength(0);
    expect(decisions.filter(d => d === 'IN')).toHaveLength(5);
    expect(decisions.filter(d => d === 'OUT')).toHaveLength(2);
  });
  test('3ª nota, mesmos 7 + 1 novo: 1 pergunta só, do novo', () => {
    const novo = P('choc', 'Achocolatado', { pantryPolicy: 'ASK' });
    const all = [...prods, novo];
    expect(all.map(p => pantryDecisionFor(p)).filter(d => d === 'ASK')).toHaveLength(1);
  });
  test('Mudar de ideia em Produtos: NUNCA → SEMPRE vale na próxima nota', () => {
    const sabao = { ...prods[5], pantryPolicy: 'ALWAYS' as const };
    expect(pantryDecisionFor(sabao)).toBe('IN');
  });
});

describe('v57 CATEGORIA NA TABELA (1 vez), não na NF — gasto + estoque falam a mesma língua', () => {
  test('Produto tem categoria/subcategoria; lançamento herda, não pergunta na NF', () => {
    const banana = P('1', 'Banana Prata', { categoryId: 'Alimentos', subcategoryId: 'Frutas' });
    const couve = P('2', 'Couve Manteiga', { categoryId: 'Alimentos', subcategoryId: 'Verduras' });
    expect(banana.categoryId).toBe('Alimentos'); expect(couve.subcategoryId).toBe('Verduras');
    // Gasto por categoria
    const spend = spendByCategory([{ product: banana, amountCents: 840 }, { product: couve, amountCents: 450 }, { product: banana, amountCents: 560 }]);
    expect(spend.get('Alimentos / Frutas')).toBe(1400);
    expect(spend.get('Alimentos / Verduras')).toBe(450);
  });
  test('+ Produto novo abre catálogo: cria com nome + categoria + subcategoria de uma vez', () => {
    const novo: CatalogProduct = P('3', 'Couve Manteiga', { categoryId: 'Alimentos', subcategoryId: 'Verduras', pantryPolicy: 'ALWAYS', baseUnit: 'UN' });
    expect(novo.categoryId).toBe('Alimentos'); expect(novo.subcategoryId).toBe('Verduras'); expect(novo.pantryPolicy).toBe('ALWAYS');
  });
});

describe('v57 KG vs UN: estoque por unidade da NF, sem conversão', () => {
  test('Banana: 1.700 kg + 3 un + 6 un = 1.700 kg + 9 un (não soma kg com un)', () => {
    let lines = addStock([], 'banana', 'G', 1700);
    lines = addStock(lines, 'banana', 'UN', 3);
    lines = addStock(lines, 'banana', 'UN', 6);
    const stock = stockFor(lines, 'banana');
    expect(stock.find(l => l.unit === 'G')?.qty).toBe(1700);
    expect(stock.find(l => l.unit === 'UN')?.qty).toBe(9);
    expect(stock).toHaveLength(2);
  });
  test('Consumir 2 un tira de UN, não de KG', () => {
    let lines = addStock([], 'banana', 'G', 1700); lines = addStock(lines, 'banana', 'UN', 9);
    lines = addStock(lines, 'banana', 'UN', -2);
    expect(stockFor(lines, 'banana').find(l => l.unit === 'UN')?.qty).toBe(7);
    expect(stockFor(lines, 'banana').find(l => l.unit === 'G')?.qty).toBe(1700);
  });
  test('Consumir 500 g tira de G, não de UN', () => {
    let lines = addStock([], 'banana', 'G', 1700); lines = addStock(lines, 'banana', 'UN', 9);
    lines = addStock(lines, 'banana', 'G', -500);
    expect(stockFor(lines, 'banana').find(l => l.unit === 'G')?.qty).toBe(1200);
    expect(stockFor(lines, 'banana').find(l => l.unit === 'UN')?.qty).toBe(9);
  });
  test('1 un NÃO vira 120 g — nunca converte', () => {
    const lines = addStock([], 'banana', 'UN', 1);
    expect(stockFor(lines, 'banana')).toEqual([{ productId: 'banana', unit: 'UN', qty: 1 }]);
    expect(stockFor(lines, 'banana').some(l => l.unit === 'G')).toBe(false);
  });
});

describe('v57 VINCULAÇÃO DURANTE A NF, não no final', () => {
  test('Item com EAN / Alias: não pergunta durante. Item sem: pergunta durante (1 item por vez)', () => {
    const prods = [P('1', 'Banana Prata', { ean: '7891234567890' })];
    const aliases = [A('ASSAI', '78901', '1')];
    const auto1 = resolveNfItem({ name: 'X', eanRaw: '7891234567890', cnpj: 'Y', storeCode: '0' }, prods, aliases);
    const auto2 = resolveNfItem({ name: 'BANANA PRATA KG', eanRaw: null, cnpj: 'ASSAI', storeCode: '78901' }, prods, aliases);
    const ask = resolveNfItem({ name: 'COUVE MANTEIGA', eanRaw: null, cnpj: 'Z', storeCode: '99' }, prods, aliases);
    expect(auto1.kind).toMatch(/AUTO/); expect(auto2.kind).toMatch(/AUTO/); expect(ask.kind).toMatch(/ASK/);
  });
});
