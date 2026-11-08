/**
 * v25 — GERADORES de páginas SEFAZ-SP para a bateria NFC-e (500+ casos).
 * Baseados nos layouts REAIS capturados do portal
 * (www.nfce.fazenda.sp.gov.br — ConsultaQRCode / NFCeConsultaPublica):
 *  · LEGADO: tabela com spans txtTit/txtCod/Rqtd/RUN/valor por item;
 *  · NOVO: linhas <td> com "Rótulo: Valor" e item em linha compacta +
 *    linha de detalhes (Código do produto (GTIN/EAN), Qtde. total de itens,
 *    Unidade comercial, Valor total do item);
 *  · TEXTO: nós corridos "Rótulo: VALOR" (layout de célula única).
 * Determinístico (mulberry32) para reproducibilidade total.
 */

/** PRNG determinístico (cópia local — sem importar o oráculo de saldo). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = <T,>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)];

export interface GenItem {
  description: string;
  ean: string | null;
  storeCode: string | null;
  qty: number;
  unit: string;
  unitCents: number;
  totalCents: number;
}

const NOMES = [
  'LEITE INTEGRAL 1L', 'CAFÉ TORRADO 500G', 'ARROZ BRANCO 5KG', 'ÓLEO DE SOJA 900ML',
  'PÃO FRANCÊS KG', 'BANANA PRATA KG', 'SABONETE DOVE 90G', 'REFRIGERANTE COLA 2L',
  'MACARRÃO ESPAGUETE 500G', 'AÇÚCAR REFINADO 1KG', 'DETERJANTE NEUTRO 500ML', 'CREME DENTAL 90G',
];
const UNITS = ['UN', 'KG', 'G', 'L', 'ML', 'CX', 'UND'];

const fmt = (cents: number): string =>
  (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brl = (cents: number): string => `R$ ${fmt(cents)}`;
const qtyStr = (q: number): string => q.toFixed(4).replace('.', ',');
const qtyStrCompact = (q: number): string => String(q).replace('.', ',');

/** Gera 1..n itens determinísticos. */
export function genItems(r: () => number, n: number): GenItem[] {
  const out: GenItem[] = [];
  for (let i = 0; i < n; i++) {
    const description = `${pick(r, NOMES)} ${i + 1}`;
    const unit = pick(r, UNITS);
    const qty = pick(r, [1, 2, 3, 0.5, 0.25, 1.5, 10]);
    const unitCents = 100 + Math.floor(r() * 9000);
    let totalCents = Math.round(qty * unitCents);
    if (unit === 'KG' || unit === 'L') totalCents = Math.round(qty * unitCents);
    const hasEan = r() < 0.7;
    out.push({
      description,
      ean: hasEan ? String(7890000000000 + Math.floor(r() * 999999999)) : null,
      storeCode: hasEan ? null : `${Math.floor(r() * 900000 + 100000)}`,
      qty,
      unit,
      unitCents,
      totalCents,
    });
  }
  return out;
}

export interface GenHeader {
  store: string;
  cnpj: string;
  issued: string; // dd/mm/aaaa hh:mm:ss
  grossCents: number;
  paidCents: number;
  discountCents: number;
  withPaid: boolean;
  withDiscount: boolean;
}

export function genHeader(r: () => number): GenHeader {
  const grossCents = 1000 + Math.floor(r() * 900000);
  const withPaid = r() < 0.6;
  const paidCents = withPaid ? grossCents + Math.floor(r() * 5000) : grossCents;
  const withDiscount = r() < 0.3;
  const discountCents = withDiscount ? Math.floor(r() * 2000) : 0;
  const d = String(1 + Math.floor(r() * 28)).padStart(2, '0');
  const mo = String(1 + Math.floor(r() * 12)).padStart(2, '0');
  const h = String(Math.floor(r() * 24)).padStart(2, '0');
  const mi = String(Math.floor(r() * 60)).padStart(2, '0');
  const s = String(Math.floor(r() * 60)).padStart(2, '0');
  return {
    store: `${pick(r, ['MERCADO', 'SUPERMERCADO', 'PADARIA', 'ATACADO'])} ${pick(r, ['ALVORADA', 'CENTRAL', 'DO POVO', 'BOM PREÇO'])} LTDA`,
    cnpj: `${String(10 + Math.floor(r() * 80)).padStart(2, '0')}.${String(100 + Math.floor(r() * 899))}.${String(100 + Math.floor(r() * 899))}/0001-${String(10 + Math.floor(r() * 89))}`,
    issued: `${d}/${mo}/2026 ${h}:${mi}:${s}`,
    grossCents,
    paidCents,
    discountCents,
    withPaid,
    withDiscount,
  };
}

/** Layout LEGADO (spans txtTit/txtCod/Rqtd/RUN/valor) — estrutura da página antiga. */
export function docLegacy(h: GenHeader, items: GenItem[]): string {
  const head = `
<table><tr><td>
<span class="label">Nome Empresarial</span><span class="text">${h.store}</span>
<span class="label">CNPJ</span><span class="text">${h.cnpj}</span>
<span class="label">Data e Hora da Emissão</span><span class="text">${h.issued}</span>
<span class="label">Valor Total</span><span class="text">${brl(h.grossCents)}</span>
${h.withPaid ? `<span class="label">Valor Pago</span><span class="text">${brl(h.paidCents)}</span>` : ''}
${h.withDiscount ? `<span class="label">Desconto</span><span class="text">${brl(h.discountCents)}</span>` : ''}
</td></tr></table>`;
  const rows = items
    .map(
      (it) => `<tr><td>
<span class="txtTit">${it.description}</span>
<span class="txtCod">Código do produto (${it.ean ? 'GTIN/EAN' : 'loja'}): ${it.ean ?? it.storeCode}</span>
<span class="Rqtd">Qtde. total de itens: ${qtyStr(it.qty)}</span>
<span class="RUN">Unidade comercial: ${it.unit}</span>
<span class="valor">Valor total do item: ${brl(it.totalCents)}</span>
</td></tr>`
    )
    .join('\n');
  return `<html><body><h1>Dados da NFC-e</h1>${head}<table>${rows}</table>
<div>Valor Total: ${brl(h.grossCents)} · Valor a Pagar: ${brl(h.paidCents)}</div></body></html>`;
}

/** Layout NOVO (linha compacta + linha de detalhes em CÉLULAS separadas). */
export function docNovo(h: GenHeader, items: GenItem[]): string {
  const head = `
<table>
<tr><td>Nome Empresarial: ${h.store}</td></tr>
<tr><td>CNPJ: ${h.cnpj}</td></tr>
<tr><td>Data e Hora da Emissão: ${h.issued}</td></tr>
<tr><td>Valor Total: ${brl(h.grossCents)}</td></tr>
${h.withPaid ? `<tr><td>Valor Pago: ${brl(h.paidCents)}</td></tr>` : ''}
${h.withDiscount ? `<tr><td>Desconto: ${brl(h.discountCents)}</td></tr>` : ''}
</table>`;
  const rows = items
    .map(
      (it, idx) => `<tr><td>${idx + 1}</td><td>${it.description}</td><td>${qtyStrCompact(it.qty)} ${it.unit} x ${brl(it.unitCents)}</td><td>${brl(it.totalCents)}</td></tr>
<tr><td colspan="2"></td><td>Código do produto (GTIN/EAN):</td><td>${it.ean ?? it.storeCode}</td><td>Qtde. total de itens:</td><td>${qtyStr(it.qty)}</td><td>Unidade comercial:</td><td>${it.unit}</td><td>Valor total do item:</td><td>${brl(it.totalCents)}</td></tr>`
    )
    .join('\n');
  return `<html><body><h1>Nota Fiscal do Consumidor Eletrônica</h1>${head}<table>${rows}</table></body></html>`;
}


/** Layout TABELA (uma linha por item, células separadas — portal público). */
export function docTabela(h: GenHeader, items: GenItem[]): string {
  const head = `
<table>
<tr><td>Nome Empresarial</td><td>${h.store}</td></tr>
<tr><td>CNPJ</td><td>${h.cnpj}</td></tr>
<tr><td>Data e Hora da Emissão</td><td>${h.issued}</td></tr>
<tr><td>Valor Total</td><td>${brl(h.grossCents)}</td></tr>
${h.withPaid ? `<tr><td>Valor Pago</td><td>${brl(h.paidCents)}</td></tr>` : ''}
${h.withDiscount ? `<tr><td>Desconto</td><td>${brl(h.discountCents)}</td></tr>` : ''}
</table>`;
  const rows = items
    .map(
      (it) => `<tr><td>${it.description}</td><td>${it.ean ?? it.storeCode}</td><td>${qtyStr(it.qty)}</td><td>${it.unit}</td><td>${brl(it.totalCents)}</td></tr>`
    )
    .join('\n');
  return `<html><body><h1>Informações da Nota — NFC-e</h1>${head}<table>${rows}</table></body></html>`;
}
