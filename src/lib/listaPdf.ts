/**
 * v100 — Geração de PDF da Lista de Compra (formato "manuscrito" pedido
 * pelo usuário: simples, limpo, para levar no papel / no celular).
 * Usa `expo-print` (já vem no Expo Go 58) — única dependência nova da v100.
 * v14 — visual de FOLHA DE CADERNO/BLOCO DE MERCADO: fundo creme com pauta
 * azul-claro, margem vermelha à esquerda, tinta azul, fonte manuscrita da
 * pilha do sistema, sublinhado ondulado no título, caixinha ☐ em cada item,
 * preço ligado por pontilhado e total estimado com sublinhado duplo.
 */

import { Platform } from 'react-native';
import { displayProductName } from './productName';

export interface ListaPdfLine {
  productName: string;
  qty: string;
  /** Preço estimado em reais (formato "R$ 0,00") — opcional. */
  priceLabel?: string;
  /** Categoria do produto (opcional, exibida como sub-rótulo). */
  categoryLabel?: string;
}

export interface ListaPdfGroup {
  title: string;
  lines: ListaPdfLine[];
  /** Total do grupo (R$), se houver. */
  totalLabel?: string;
}

export interface ListaPdfInput {
  title: string;
  subtitle?: string;
  groups: ListaPdfGroup[];
  grandTotalLabel?: string;
  /** "dd/mm/aaaa hh:mm" — gerado na hora se não vier. */
  generatedAt?: string;
}

const escape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Constrói o HTML estilo "folha de caderno / bloco de mercado". */
export function buildListaHtml(input: ListaPdfInput): string {
  const date = input.generatedAt ?? defaultBrDateTime();
  const ts = escape(date);

  const style = `
    @page { size: A4; margin: 16mm; }
    html, body { background: #fffdf3; }
    body {
      font-family: "Bradley Hand", "Noteworthy", "Segoe Print", "Marker Felt", "Comic Sans MS", cursive;
      color: #1f3a8a;
      font-size: 14px;
      line-height: 1.3;
      margin: 0;
      padding: 0;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      background-color: #fffdf3;
      /* Pauta azul-claro a cada 28px (por baixo) + margem vermelha à esquerda
         (por cima). A barra vermelha é estreita e fica antes do conteúdo. */
      background-image:
        repeating-linear-gradient(
          to bottom,
          rgba(0,0,0,0) 0,
          rgba(0,0,0,0) 27px,
          #cfe1f5 27px,
          #cfe1f5 28px
        ),
        linear-gradient(to right, #f7c8c8 0, #f7c8c8 18px, rgba(0,0,0,0) 18px);
      background-repeat: repeat, no-repeat;
      background-size: 100% 28px, 100% 100%;
    }
    .page-wrap { padding: 0 4mm 0 calc(4mm + 24px); }
    .head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 12px;
      padding: 2px 0 4px 0;
    }
    .title {
      flex: 1;
      font-size: 34px;
      line-height: 1.1;
      margin: 0;
      padding: 0 0 4px 0;
      border-bottom: 2px wavy #1f3a8a;
    }
    .date {
      font-size: 11px;
      opacity: 0.7;
      white-space: nowrap;
      padding: 0 0 6px 0;
    }
    .subtitle {
      font-size: 12px;
      margin: 2px 0 8px 0;
      opacity: 0.85;
    }
    .group { margin-top: 8px; }
    .group-title {
      font-size: 19px;
      margin: 10px 0 4px 0;
      padding: 0 0 2px 0;
      border-bottom: 1.5px solid #1f3a8a;
      page-break-after: avoid;
      page-break-inside: avoid;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
    }
    .group-title .name { font-weight: bold; }
    .group-total-inline {
      font-size: 14px;
      font-weight: bold;
      padding-left: 8px;
      white-space: nowrap;
    }
    .item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 0 4px 0;
      margin: 0 0 2px 0;
      border-bottom: 1px dotted #1f3a8a;
      page-break-inside: avoid;
    }
    .item .check {
      flex: 0 0 14px;
      width: 14px;
      height: 14px;
      border: 1.5px solid #1f3a8a;
      /* borda irregular — dá o ar de caixinha desenhada à mão */
      border-radius: 2px 5px 3px 4px;
      display: inline-block;
      box-sizing: border-box;
    }
    .item .qty { font-weight: bold; margin-right: 2px; }
    .item .name { flex: 1; min-width: 0; }
    .item .cat {
      font-size: 11px;
      opacity: 0.7;
      margin-left: 4px;
    }
    .item .price {
      font-size: 13px;
      white-space: nowrap;
      padding: 0 2px 0 8px;
    }
    .item.rot-a { transform: rotate(-0.4deg); }
    .item.rot-b { transform: rotate(0.3deg); }
    .group-total-line {
      display: flex;
      justify-content: flex-end;
      font-weight: bold;
      margin: 4px 0 2px 0;
      page-break-inside: avoid;
    }
    .grand-total {
      margin: 18px 0 4px 0;
      padding: 6px 4px;
      border-top: 4px double #1f3a8a;
      border-bottom: 4px double #1f3a8a;
      text-align: right;
      font-size: 20px;
      font-weight: bold;
      page-break-inside: avoid;
    }
    .stamp {
      font-size: 10px;
      opacity: 0.6;
      text-align: right;
      margin-top: 12px;
    }
  `.trim();

  const groupsHtml = input.groups.map((g) => `
    <div class="group">
      <h2 class="group-title">
        <span class="name">${escape(g.title)}</span>
        ${g.totalLabel ? `<span class="group-total-inline">→ ${escape(g.totalLabel)}</span>` : ''}
      </h2>
      ${g.lines.map((l, i) => `
        <div class="item ${i % 2 === 0 ? 'rot-a' : 'rot-b'}">
          <span class="check"></span>
          ${l.qty ? `<span class="qty">${escape(l.qty)}</span>` : ''}
          <span class="name">${escape(displayProductName(l.productName) || l.productName)}${l.categoryLabel ? ` <span class="cat">(${escape(l.categoryLabel)})</span>` : ''}</span>
          ${l.priceLabel ? `<span class="price">${escape(l.priceLabel)}</span>` : ''}
        </div>
      `).join('')}
      ${g.totalLabel ? `<div class="group-total-line">Subtotal: ${escape(g.totalLabel)}</div>` : ''}
    </div>
  `).join('');

  const body = `
    <div class="head">
      <h1 class="title">${escape(input.title)}</h1>
      <div class="date">${ts}</div>
    </div>
    ${input.subtitle ? `<div class="subtitle">${escape(input.subtitle)}</div>` : ''}
    ${groupsHtml}
    ${input.grandTotalLabel ? `<div class="grand-total">Total estimado: ${escape(input.grandTotalLabel)}</div>` : ''}
    <div class="stamp">Gerado em ${ts}</div>
  `.trim();

  return `<!doctype html><html><head><meta charset="utf-8" /><title>${escape(input.title)}</title><style>${style}</style></head><body><div class="page-wrap">${body}</div></body></html>`;
}

function defaultBrDateTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** v100 — Imprime o HTML como PDF (expo-print). Retorna `{ uri, output }`. */
export async function printListaPdf(input: ListaPdfInput): Promise<{ uri: string }> {
  const html = buildListaHtml(input);
  // Corrige require dinâmico (não é import estático: Web/JS bundlers ainda
  // resolvem ok, mas evita-tempo-de-bundle).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Print = require('expo-print') as typeof import('expo-print');
  const { uri } = await Print.printToFileAsync({ html });
  if (Platform.OS === 'web') {
    // fallback simples: abre a janela de impressão
    if (typeof window !== 'undefined') window.open(uri, '_blank');
  }
  return { uri };
}
