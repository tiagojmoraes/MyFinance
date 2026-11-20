/**
 * v100 — Geração de PDF da Lista de Compra (formato "manuscrito" pedido
 * pelo usuário: simples, limpo, para levar no papel / no celular).
 * Usa `expo-print` (já vem no Expo Go 58) — única dependência nova da v100.
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

/** Constrói o HTML "manuscrito" (preto, margens, lista simples). */
export function buildListaHtml(input: ListaPdfInput): string {
  const date = input.generatedAt ?? defaultBrDateTime();
  const ts = escape(date);
  const head = `
<head>
<meta charset="utf-8" />
<title>${escape(input.title)}</title>
<style>
  @page { margin: 18mm; }
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #111; font-size: 13px; }
  h1 { font-size: 18px; margin: 0 0 4px 0; }
  h2 { font-size: 15px; margin: 12px 0 4px 0; border-bottom: 1px solid #999; padding-bottom: 2px; }
  .sub { color: #555; font-size: 11px; }
  ul { list-style: none; padding-left: 0; margin: 4px 0 8px 0; }
  li { padding: 2px 0; display: flex; justify-content: space-between; align-items: baseline; }
  .qty { font-weight: bold; margin-right: 8px; }
  .price { color: #444; font-size: 12px; }
  .total { font-weight: bold; margin-top: 8px; }
  .grand { font-size: 16px; margin-top: 12px; padding-top: 6px; border-top: 2px solid #111; }
  .stamp { color: #888; font-size: 10px; margin-top: 16px; text-align: right; }
  .cat { color: #777; font-size: 11px; }
</style>
</head>`.trim();

  const body = `
<body>
  <h1>${escape(input.title)}</h1>
  ${input.subtitle ? `<div class="sub">${escape(input.subtitle)}</div>` : ''}
  ${input.groups.map((g) => `
    <h2>${escape(g.title)}</h2>
    <ul>
      ${g.lines.map((l) => `
        <li>
          <span>${l.qty ? `<span class="qty">${escape(l.qty)}</span>` : ''}${escape(displayProductName(l.productName) || l.productName)}${l.categoryLabel ? ` <span class="cat">(${escape(l.categoryLabel)})</span>` : ''}</span>
          ${l.priceLabel ? `<span class="price">${escape(l.priceLabel)}</span>` : ''}
        </li>`).join('')}
    </ul>
    ${g.totalLabel ? `<div class="total">Total: ${escape(g.totalLabel)}</div>` : ''}
  `).join('')}
  ${input.grandTotalLabel ? `<div class="grand">Total estimado: ${escape(input.grandTotalLabel)}</div>` : ''}
  <div class="stamp">Gerado em ${ts}</div>
</body>`.trim();
  return `<!doctype html><html>${head}${body}</html>`;
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
