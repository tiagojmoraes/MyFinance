/**
 * v100 — Geração de PDF da Lista de Compra (formato "manuscrito" pedido
 * pelo usuário: simples, limpo, para levar no papel / no celular).
 * Usa `expo-print` (já vem no Expo Go 58) — única dependência nova da v100.
 * v14 — visual de FOLHA DE CADERNO/BLOCO DE MERCADO: fundo creme com pauta
 * azul-claro, margem vermelha à esquerda, tinta azul, fonte manuscrita da
 * pilha do sistema, sublinhado ondulado no título, caixinha ☐ em cada item.
 * v108 — visual SÓBRIO, unissex e de fácil leitura: fundo branco, azul sóbrio
 * de destaque (#1e3a5f), fonte "Helvetica Neue", sem efeitos manuscritos e
 * sem rotações nos itens. Caixinha ☐ reta com border-radius 2px; total com
 * borda azul e sem sublinhado duplo; separador sólido fino cinza em vez de
 * pontilhado azul. Estrutura e informações do layout v14 preservadas.
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

/** Constrói o HTML sóbrio e de fácil leitura (v108). Estrutura v14 preservada. */
export function buildListaHtml(input: ListaPdfInput): string {
  const date = input.generatedAt ?? defaultBrDateTime();
  const ts = escape(date);

  const style = `
    @page { size: A4; margin: 16mm; }
    html, body { background: #ffffff; }
    body {
      font-family: "Helvetica Neue", Helvetica, Arial, "Segoe UI", Roboto, sans-serif;
      color: #111827;
      font-size: 14px;
      line-height: 1.35;
      margin: 0;
      padding: 0;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
      background-color: #ffffff;
    }
    .page-wrap { padding: 0; }
    .head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 12px;
      padding: 2px 0 6px 0;
    }
    .title {
      flex: 1;
      color: #1e3a5f;
      font-size: 26px;
      line-height: 1.15;
      font-weight: 700;
      margin: 0;
      padding: 0 0 4px 0;
    }
    .date {
      font-size: 11px;
      color: #475569;
      white-space: nowrap;
      padding: 0 0 6px 0;
    }
    .subtitle {
      font-size: 12px;
      color: #475569;
      margin: 2px 0 12px 0;
    }
    .group { margin-top: 14px; }
    .group-title {
      color: #1e3a5f;
      font-size: 15px;
      font-weight: 700;
      margin: 12px 0 6px 0;
      padding: 0 0 4px 0;
      border-bottom: 1px solid #1e3a5f;
      page-break-after: avoid;
      page-break-inside: avoid;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
    }
    .group-title .name { font-weight: 700; }
    .group-total-inline {
      font-size: 13px;
      font-weight: 700;
      color: #1e3a5f;
      padding-left: 8px;
      white-space: nowrap;
    }
    .item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0 5px 0;
      margin: 0 0 2px 0;
      border-bottom: 1px solid #e5e7eb;
      page-break-inside: avoid;
    }
    .item .check {
      flex: 0 0 14px;
      width: 14px;
      height: 14px;
      border: 1.5px solid #1e3a5f;
      border-radius: 2px;
      display: inline-block;
      box-sizing: border-box;
    }
    .item .qty {
      color: #111827;
      font-weight: 700;
      margin-right: 2px;
    }
    .item .name { flex: 1; min-width: 0; color: #111827; }
    .item .cat {
      font-size: 11px;
      color: #475569;
      margin-left: 4px;
    }
    .item .price {
      font-size: 13px;
      color: #111827;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      padding: 0 0 0 8px;
    }
    .group-total-line {
      display: flex;
      justify-content: flex-end;
      color: #1e3a5f;
      font-weight: 700;
      margin: 6px 0 2px 0;
      page-break-inside: avoid;
    }
    .grand-total {
      margin: 22px 0 6px 0;
      padding: 10px 8px;
      border: 1.5px solid #1e3a5f;
      text-align: right;
      color: #1e3a5f;
      font-size: 18px;
      font-weight: 700;
      page-break-inside: avoid;
    }
    .stamp {
      font-size: 10px;
      color: #475569;
      text-align: right;
      margin-top: 14px;
    }
  `.trim();

  const groupsHtml = input.groups.map((g) => `
    <div class="group">
      <h2 class="group-title">
        <span class="name">${escape(g.title)}</span>
        ${g.totalLabel ? `<span class="group-total-inline">→ ${escape(g.totalLabel)}</span>` : ''}
      </h2>
      ${g.lines.map((l) => `
        <div class="item">
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
