/**
 * NfceWebEngine — v35: O MOTOR DO APARELHO como 1º degrau da leitura NFC-e.
 *
 * PEDIDO DO USUÁRIO ("colocar o mesmo processo da aplicação que funciona na
 * função NFC-e"): o app nativo que lê a nota não usa JavaScript — quem faz o
 * pedido é o PRÓPRIO CELULAR, com a pilha de rede real (TLS, ordem de
 * cabeçalhos, cookies e execução de JavaScript nativos). O `fetch` do
 * JavaScript (v32–v34) envia os MESMOS cabeçalhos e MESMA URL, mas por dentro
 * é um cliente diferente — e é esse "por dentro" que o firewall F5 da
 * SEFAZ-SP julga: a v34, testada pelo usuário, continuou recusada.
 *
 * A ponte para o processo REAL do aparelho dentro do Expo é a WebView
 * (react-native-webview, já incluída no Expo Go): ela É o motor de navegador
 * do Android — a mesma classe de cliente que abre a nota quando o usuário
 * toca no link. Com ela:
 *  · o desafio JavaScript do F5 (cookies TS*, TSPD) executa NATIVAMENTE e o
 *    reload automático já sai com a sessão aberta — fetch nunca consegue isso;
 *  · a identidade é GENUÍNA (sem User-Agent inventado: UA mentiroso conflita
 *    com a impressão digital real da engine e vira marca de robô);
 *  · os cookies do desafio PERSISTEM entre notas (sharedCookiesEnabled) —
 *    as consultas seguintes nascem com a sessão já quente.
 *
 * Este módulo é a PONTE (sem React, 100% testável): o serviço pede
 * `nfceWebEngine.read(url, timeout)` e o componente NfceWebEngineView
 * (WebView oculta de 1×1 px, montada no layout raiz) executa o trabalho e
 * devolve o HTML renderizado. Sem componente montado (ex.: testes), `read`
 * devolve null e a cadeia segue para os degraus antigos.
 */

import { isFirewallRejectionPage, looksLikeNfcePage } from '../parsers/nfce';

/** Resultado de um trabalho do motor: HTML renderizado + URL que o gerou. */
export interface NfceWebEngineResult {
  html: string;
  url: string;
}

/** Contrato que o componente (WebView) registra para receber os trabalhos. */
export interface NfceWebEngineDriver {
  read(url: string, timeoutMs: number): Promise<NfceWebEngineResult | null>;
}

/** Tempo máximo de UM canal no motor (mesmo orçamento do fetch direto). */
export const WEBENGINE_TIMEOUT_MS = 20_000;

/**
 * Esperas do motor quando a página ainda NÃO é a nota:
 *  · desafio do F5 (TSPD/APM_DO_NOT_TOUCH): o portal recarrega sozinho —
 *    até 4 recapturas (o reload costuma chegar em 1–3 s);
 *  · página desconhecida ( nem nota, nem desafio, nem rejeição): até 2
 *    recapturas curtas antes de entregar o que tiver ao serviço.
 */
export const CHALLENGE_MAX_WAITS = 4;
export const UNKNOWN_MAX_WAITS = 2;

/**
 * v35 — Decisão PURA sobre o HTML capturado pelo motor (testável sem RN).
 *  · deliver    → é a nota: devolve ao serviço;
 *  · hand-over  → rejeição dura do firewall ("Request Rejected"): NÃO vai
 *                 resolver com espera — o serviço tenta o próximo canal;
 *  · wait       → desafio/intermediária: esperar o reload e capturar de novo.
 * A página da nota vence SEMPRE (mesmo que carregue algum marcador de desafio
 * no meio do HTML — o critério de nota do parser já trata isso).
 */
export type WebEngineCaptureDecision =
  | { action: 'deliver' }
  | { action: 'hand-over'; kind: 'rejection' }
  | { action: 'wait'; kind: 'challenge' | 'unknown'; delayMs: number };

export function decideCaptureAction(html: string): WebEngineCaptureDecision {
  if (looksLikeNfcePage(html)) return { action: 'deliver' };
  if (isFirewallRejectionPage(html)) return { action: 'hand-over', kind: 'rejection' };
  if (/TSPD|APM_DO_NOT_TOUCH/i.test(html)) {
    return { action: 'wait', kind: 'challenge', delayMs: 2500 };
  }
  return { action: 'wait', kind: 'unknown', delayMs: 1500 };
}

/**
 * v36 — A identidade do motor é uma WebView GENUÍNA?
 *
 * Padrão medido na captura Reqable do app que funciona (análise JSON do
 * usuário): "Mozilla/5.0 (Linux; Android 13; moto g52 Build/T2SRS33.72-22-4-11;
 * wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.47 Mobile
 * Safari/537.36". As marcas obrigatórias:
 *  · "; wv)" — WebView embutida (o próprio JSON a chama de INDICADOR
 *    CRÍTICO: é o que prova que o app que funciona navega via WebView);
 *  · "Chrome/<versão>" — motor Chromium real do aparelho;
 *  · "AppleWebKit/537.36" — engine de renderização.
 * O motor (NfceWebEngineView) NÃO inventa User-Agent — usa o do sistema. Esta
 * função serve de PROVA no terminal: comparamos o UA real do aparelho com o
 * padrão da captura e registramos o veredito a cada consulta.
 */
export function isGenuineWebViewUa(ua: string): boolean {
  return /;\s*wv\)/i.test(ua) && /Chrome\/\d+/i.test(ua) && /AppleWebKit\/537\.36/i.test(ua);
}

class NfceWebEngineBridge {
  private driver: NfceWebEngineDriver | null = null;

  /** Componente montou a WebView oculta — passa a receber trabalhos. */
  attach(driver: NfceWebEngineDriver): void {
    this.driver = driver;
  }

  /** Componente desmontou — a cadeia volta a pular este degrau. */
  detach(driver: NfceWebEngineDriver): void {
    if (this.driver === driver) this.driver = null;
  }

  /** Há motor disponível? (falso em testes/antes do mount — degrau pulado) */
  hasDriver(): boolean {
    return this.driver !== null;
  }

  /**
   * Executa um trabalho no motor. NUNCA lança: qualquer falha vira null
   * (o serviço segue a cadeia — mesma tolerância do fetch direto).
   */
  async read(url: string, timeoutMs: number): Promise<NfceWebEngineResult | null> {
    const driver = this.driver;
    if (!driver) return null;
    try {
      return await driver.read(url, timeoutMs);
    } catch {
      return null;
    }
  }
}

/** Singleton da ponte (importado pelo NfceService e pelo componente). */
export const nfceWebEngine = new NfceWebEngineBridge();
