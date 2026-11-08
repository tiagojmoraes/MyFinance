/**
 * nfceReader — v33: SERVIÇO DE LEITURA (o "ajudante na nuvem") para NFC-e.
 *
 * DIAGNÓSTICO FECHADO (sondagens e logs reais):
 *  - O portal da SEFAZ-SP está atrás de firewall F5/BIG-IP que julga o CLIENTE
 *    da requisição (fingerprint + reputação de IP). No celular, TODOS os
 *    caminhos foram recusados: o pedido direto do app (v32, okhttp) e o
 *    navegador embutido (WebView) — mesmo com WiFi residencial limpo
 *    (logs 22:20–22:21, v32 rodando no aparelho do usuário).
 *  - Clientes "de fora" passam: o PowerShell no PC do usuário (HTTP 200 com a
 *    página completa) e a IA de chat que leu o link com navegador de verdade.
 *
 * SOLUÇÃO: o app passa a poder DELEGAR a busca a um serviço profissional de
 * leitura de páginas (ScrapingBee ou ScraperAPI). Esses serviços mantêm
 * navegador completo + frota de proxies — exatamente a receita que funciona —
 * e é trabalho DELES manter o acesso funcionando se o firewall mudar
 * (o APK não precisa de nova versão para isso).
 *
 * O usuário cria a conta grátis (1.000 créditos, sem cartão) e cola a chave em
 * Ajustes > Leitura de notas. Sem chave configurada, o app se comporta
 * exatamente como na v32 (leitura direta → navegador interno).
 *
 * Economia de créditos: cadeia ADAPTATIVA —
 *   1. pedido simples (1 crédito; o mesmo formato que passou no PowerShell);
 *   2. com navegador (render JS; ~5–10 créditos — resolve desafio do F5);
 *   3. navegador + proxy premium (IP residencial dedicado).
 * Para na primeira tentativa que entregar a página da nota.
 */

import { isFirewallRejectionPage } from '../parsers/nfce';

export type NfceReaderProvider = 'none' | 'scrapingbee' | 'scraperapi';

export interface NfceReaderConfig {
  provider: NfceReaderProvider;
  apiKey: string;
}

/** Timeout por tentativa (render JS pode levar dezenas de segundos). */
const READER_TIMEOUT_MS = 60_000;

/** Configuração utilizável? (provedor escolhido + chave colada). */
export function isReaderConfigured(cfg: NfceReaderConfig | null): boolean {
  return !!cfg && cfg.provider !== 'none' && cfg.apiKey.trim().length > 0;
}

/** Rótulo amigável para logs/telas. */
export function readerProviderLabel(provider: NfceReaderProvider): string {
  if (provider === 'scrapingbee') return 'ScrapingBee';
  if (provider === 'scraperapi') return 'ScraperAPI';
  return 'Nenhum';
}

/**
 * Endpoint HTTP do provedor — a resposta é o HTML da página pedida.
 * O endereço da SEFAZ vai ENCODADO como parâmetro (o serviço é quem visita).
 */
export function buildReaderEndpoint(
  provider: Exclude<NfceReaderProvider, 'none'>,
  apiKey: string,
  targetUrl: string,
  opts: { renderJs: boolean; premiumProxy: boolean }
): string {
  const url = encodeURIComponent(targetUrl);
  const key = encodeURIComponent(apiKey.trim());
  if (provider === 'scrapingbee') {
    return (
      `https://app.scrapingbee.com/api/v1/?api_key=${key}&url=${url}` +
      `&render_js=${opts.renderJs ? 'true' : 'false'}` +
      (opts.premiumProxy ? '&premium_proxy=true' : '')
    );
  }
  // scraperapi
  return (
    `https://api.scraperapi.com/?api_key=${key}&url=${url}` +
    `&render=${opts.renderJs ? 'true' : 'false'}` +
    (opts.premiumProxy ? '&premium=true' : '')
  );
}

/** Uma tentativa no provedor. Devolve o HTML ou o motivo da falha. */
async function fetchHtmlViaReader(
  cfg: NfceReaderConfig,
  targetUrl: string,
  opts: { renderJs: boolean; premiumProxy: boolean }
): Promise<{ html: string | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READER_TIMEOUT_MS);
  try {
    const endpoint = buildReaderEndpoint(
      cfg.provider as 'scrapingbee' | 'scraperapi',
      cfg.apiKey,
      targetUrl,
      opts
    );
    const res = await fetch(endpoint, { signal: controller.signal });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 160).replace(/\s+/g, ' ');
      } catch {
        // corpo vazio — segue sem detalhe
      }
      return { html: null, error: `HTTP ${res.status}${detail ? ` — ${detail}` : ''}` };
    }
    const text = await res.text();
    if (!text || !/<html|<!doctype/i.test(text)) {
      return { html: null, error: 'resposta não é HTML' };
    }
    if (isFirewallRejectionPage(text)) {
      return { html: null, error: 'o portal recusou o cliente do serviço' };
    }
    return { html: text, error: null };
  } catch (err) {
    return { html: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cadeia adaptativa de tentativas (crédito barato → caro), parando na primeira
 * que entregar a página. `attempts` traz o relato de cada degrau para o log.
 */
export async function fetchNoteViaReader(
  cfg: NfceReaderConfig,
  targetUrl: string
): Promise<{ html: string | null; attempts: string[] }> {
  const attempts: string[] = [];
  const plan = [
    { label: 'simples (1 crédito)', opts: { renderJs: false, premiumProxy: false } },
    { label: 'navegador/render JS', opts: { renderJs: true, premiumProxy: false } },
    { label: 'navegador + proxy premium', opts: { renderJs: true, premiumProxy: true } },
  ];
  for (const step of plan) {
    const r = await fetchHtmlViaReader(cfg, targetUrl, step.opts);
    attempts.push(`${step.label} → ${r.html ? 'PÁGINA OK' : `falhou (${r.error ?? 'sem detalhe'})`}`);
    if (r.html) return { html: r.html, attempts };
  }
  return { html: null, attempts };
}
