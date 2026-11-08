/**
 * pcBridge — v40.2: CANAL NOVO de consulta NFC-e — o SERVIDOR DO PC.
 *
 * O QUE O LOG DO APARELHO PROVOU (v40.1, 2026-11-05 19:12–19:14): TODOS os
 * canais do motor do aparelho recusados pelo firewall F5 da SEFAZ-SP
 * ("Request Rejected", 1 KB) — com esperas de 2–5 s ENTRE tentativas e
 * portão anti-ban de 60/180 s funcionando. O firewall não julga o tempo: ele
 * julga a IDENTIDADE do cliente do celular (WebView do Expo Go — o header
 * X-Requested-With do app, impressão digital da engine) e não existe forma
 * de mudar isso dentro do Expo Go.
 *
 * A IDEA NOVA: o PC do usuário está na MESMA rede Wi-Fi — é a rede do Metro
 * do Expo Go (o celular JÁ conversa com o PC para rodar o app). Um servidor
 * minúsculo Node SEM dependências (tools/servidor-nfce.js) faz o papel do
 * Chrome do Windows: cabeçalhos completos de navegador e, se o firewall
 * recusar, o CHROME REAL do PC em modo headless. O celular NUNCA fala com a
 * SEFAZ por este canal — recebe o HTML pronto e segue com o parser de sempre
 * (etapas 6–8 inalteradas).
 *
 * DESCOBERTA AUTOMÁTICA (zero configuração): em Expo Go o app sabe o
 * endereço do PC — é o host do Metro (expoConfig.hostUri, ex.
 * "192.168.0.12:8081"). O servidor sobe na porta 3000 do MESMO PC. Sem
 * servidor (fora de casa, PC desligado), a descoberta falha em ~2 s, o
 * resultado fica em cache por 60 s e o app segue EXATAMENTE como na v40.1
 * (motor do aparelho) — ZERO regressão.
 *
 * Cabeçalho `ngrok-skip-browser-warning`/ngrok NÃO é necessário: o caminho
 * é rede local (Wi-Fi do Metro) ou `adb reverse tcp:3000 tcp:3000` (USB).
 */

/** Porta fixa do servidor do PC (tools/servidor-nfce.js). */
export const PC_PORTA = 3000;
/** Descoberta: tempo máximo de espera pelo /health de cada candidato. */
export const PC_PROBE_TIMEOUT_MS = 2_000;
/** Consulta: tempo máximo (o PC pode estar rodando o Chrome headless ~15 s). */
export const PC_CONSULTA_TIMEOUT_MS = 25_000;
/** Cache da descoberta: negativo evita sondar a cada consulta; positivo evita re-probe. */
export const PC_CACHE_TTL_MS = 60_000;

/**
 * Resultado de uma consulta via PC (protocolo do servidor-nfce.js).
 *  · ok        → HTML da nota (ou da página) pronto para o parser do app;
 *  · bloqueado → firewall recusou o PC também (html = página de rejeição);
 *  · desafio   → o portal devolveu o desafio (TSPD) ao PC também;
 *  · gate      → portão anti-ban do PC fechado (segundos restantes);
 *  · indisponivel → resposta inesperada (servidor velho/quebrado).
 */
export type PcConsultaResult =
  | { tipo: 'ok'; html: string; bytes: number; estrategia: string; ms: number }
  | { tipo: 'bloqueado'; html?: string; supportId?: string | null }
  | { tipo: 'desafio'; html?: string }
  | { tipo: 'gate'; segundos: number }
  | { tipo: 'indisponivel' };

/**
 * Candidatos de base do servidor, em ordem de tentativa:
 *  1. host do Metro do Expo Go (o PC que já serve o app — ex. 192.168.0.12);
 *  2. localhost (funciona com `adb reverse tcp:3000 tcp:3000` via USB).
 * Puro e testável: "192.168.0.12:8081" → [host, localhost]; "localhost:8081"
 * e null → só localhost.
 */
export function candidatosBase(hostUri: string | null | undefined): string[] {
  const hosts: string[] = [];
  if (hostUri && typeof hostUri === 'string') {
    const host = hostUri.split(':')[0];
    if (host && host !== 'localhost' && host !== '127.0.0.1') hosts.push(host);
  }
  hosts.push('localhost'); // adb reverse tcp:3000 tcp:3000 (USB)
  return hosts.map((h) => `http://${h}:${PC_PORTA}`);
}

/**
 * hostUri do Expo Go (ex. "192.168.0.12:8081") — null em build de produção,
 * em testes ou fora do Expo. require() protegido: se expo-constants não
 * existir no ambiente, devolve null em vez de quebrar.
 */
export function hostUriDoExpo(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('expo-constants');
    const c = (mod && (mod.default ?? mod)) as
      | { expoConfig?: { hostUri?: string }; debug?: { hostUri?: string } }
      | null;
    return c?.expoConfig?.hostUri ?? c?.debug?.hostUri ?? null;
  } catch {
    return null;
  }
}

let cacheBase: { base: string | null; at: number } = { base: null, at: 0 };

/** Zera o cache de descoberta (testes / "Tentar de novo" forçado). */
export function resetarCacheServidorPc(): void {
  cacheBase = { base: null, at: 0 };
}

/**
 * Descobre o servidor do PC: pergunta /health a cada candidato com 2 s de
 * teto e aceita quem se identificar como "nfce-pc". Resultado em cache por
 * 60 s (positivo OU negativo) — consulta nova não re-probe, PC que ligou
 * depois é descoberto na consulta seguinte.
 */
export async function acharServidorPc(fetchImpl?: typeof fetch): Promise<string | null> {
  const agora = Date.now();
  if (agora - cacheBase.at < PC_CACHE_TTL_MS) return cacheBase.base;
  const f = fetchImpl ?? fetch;
  for (const base of candidatosBase(hostUriDoExpo())) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), PC_PROBE_TIMEOUT_MS);
    try {
      const r = await f(`${base}/health`, { signal: ctl.signal });
      if (!r.ok) continue;
      const j = (await r.json()) as { servidor?: string };
      if (j?.servidor !== 'nfce-pc') continue;
      cacheBase = { base, at: Date.now() };
      return base;
    } catch {
      // candidato não respondeu — tenta o próximo (localhost via adb reverse)
    } finally {
      clearTimeout(t);
    }
  }
  cacheBase = { base: null, at: Date.now() };
  return null;
}

/**
 * Interpreta a resposta HTTP do servidor (status + corpo JSON) e devolve o
 * veredito. Pura e testável — NÃO faz rede.
 * Regras: ok:true + html real → 'ok'; desafio → 'desafio'; bloqueado →
 * 'bloqueado'; gate > 0 → 'gate'; qualquer outra coisa → 'indisponivel'.
 */
export function interpretarRespostaPc(status: number, corpo: unknown): PcConsultaResult {
  const j = (corpo ?? {}) as {
    ok?: boolean;
    html?: string;
    bytes?: number;
    estrategia?: string;
    elapsedMs?: number;
    bloqueado?: boolean;
    supportId?: string | null;
    desafio?: boolean;
    gate?: number;
  };
  if (j.ok === true && typeof j.html === 'string' && j.html.length > 80) {
    return {
      tipo: 'ok',
      html: j.html,
      bytes: j.bytes ?? j.html.length,
      estrategia: j.estrategia ?? 'fetch',
      ms: j.elapsedMs ?? 0,
    };
  }
  if (j.desafio === true) {
    return { tipo: 'desafio', html: typeof j.html === 'string' && j.html.length > 0 ? j.html : undefined };
  }
  if (j.bloqueado === true) {
    return {
      tipo: 'bloqueado',
      html: typeof j.html === 'string' && j.html.length > 0 ? j.html : undefined,
      supportId: j.supportId ?? null,
    };
  }
  if (typeof j.gate === 'number' && j.gate > 0) return { tipo: 'gate', segundos: j.gate };
  return { tipo: 'indisponivel' };
}

/**
 * Consulta a SEFAZ VIA PC: o PC fala com o portal; o app só recebe o HTML.
 * NUNCA lança: qualquer falha de rede/timeout vira null (PC sumiu) — o
 * chamador segue para o próximo canal, como hoje.
 */
export async function consultarViaPc(
  base: string,
  url: string,
  fetchImpl?: typeof fetch,
  timeoutMs: number = PC_CONSULTA_TIMEOUT_MS
): Promise<PcConsultaResult | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let r: Response;
    try {
      r = await (fetchImpl ?? fetch)(`${base}/consultar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    const texto = await r.text();
    let corpo: unknown = null;
    try {
      corpo = JSON.parse(texto);
    } catch {
      corpo = null;
    }
    return interpretarRespostaPc(r.status, corpo);
  } catch {
    return null; // PC desligou / timeout / rede — app segue a cadeia de canais
  }
}
