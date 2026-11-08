// v45 — NFC-e MÉTODO ÚNICO (rápido)
// ANTES: 5 métodos tentando um por um:
//   1. fetch direto (Dalvik) — sempre recusado pelo F5 (v30-v34 provou)
//   2. Motor do aparelho / WebView oculta 1x1 — recusado no Expo Go (X-Requested-With)
//   3. Navegador interno visível (NfceWebFetch) — recusado, 60s de portão
//   4. Serviço de leitura (reader) — custo extra, nunca foi o que funcionou
//   5. Servidor do PC (chrome.exe) — 3x seguidas OK, 18.2KB / 13.8s
// DEPOIS: SÓ O #5. 1 método, 1 caminho, sem tentativa-e-erro.
//
// Prova (log real do usuário):
//   NOTA via chrome.exe · 18.2KB · 13.8s — 3x seguidas
//   NOTA via chrome.exe · 29.1KB · 14.2s
//
// Se o PC não está no ar -> NÃO tenta WebView/fetch (só queima reputação e 60s de portão).
// Retorna erro claro: "Ligue o servidor do PC (npm run dev)" ou "Registre manual".
// No APK final (sem PC): o MESMO método vale — WebView do APK com CHROME_UA_APK
// (não Expo Go) usa o mesmo parser. 1 método, 2 execuções (PC no dev, APK no prod).

import { acharServidorPc, consultarViaPc } from '../lib/pcBridge';
import { nfceLog, nfceStep, nfceVerdict, NFCE_STEP } from '../lib/nfcelog';

export type NfceUnicoResult =
  | { ok: true; html: string; ms: number; bytes: number; via: 'PC-CHROME' }
  | { ok: false; motivo: 'PC_OFF' | 'BLOQUEADO' | 'GATE' | 'DESAFIO'; detalhe: string };

/** MÉTODO ÚNICO — escanear -> PC (chrome.exe) -> HTML -> parser. Sem fallback. */
export async function lerNfceUnico(input: string): Promise<NfceUnicoResult> {
  const t0 = Date.now();
  nfceStep(NFCE_STEP.NAVEGADOR, 'run', 'MÉTODO ÚNICO: PC (chrome.exe) — sem fetch, sem WebView, sem reader');
  const base = await acharServidorPc();
  if (!base) {
    nfceVerdict(false, 'PC_OFF', ['Servidor do PC não encontrado — rode npm run dev no PC. Sem tentar WebView/fetch (só queimaria 60s).']);
    return { ok: false, motivo: 'PC_OFF', detalhe: 'Servidor do PC não encontrado. Rode npm run dev no PC e tente de novo, ou use Registrar manual.' };
  }
  const res = await consultarViaPc(base, input);
  const ms = Date.now() - t0;
  if (!res) {
    nfceVerdict(false, 'PC_INDISPONIVEL', ['O PC não respondeu (desligou, timeout ou rede caiu).']);
    return { ok: false, motivo: 'PC_OFF', detalhe: 'O servidor do PC não respondeu. Confira o Terminal 1 e tente de novo.' };
  }
  if (res.tipo === 'ok') {
    nfceLog(`MÉTODO ÚNICO OK via PC-CHROME · ${res.bytes} bytes · ${ms}ms`);
    nfceVerdict(true, 'OK', undefined, `Nota lida via PC em ${ms}ms`);
    return { ok: true, html: res.html, ms, bytes: res.bytes, via: 'PC-CHROME' };
  }
  if (res.tipo === 'gate') return { ok: false, motivo: 'GATE', detalhe: `Portão anti-ban: aguarde ${res.segundos}s e tente 1x.` };
  if (res.tipo === 'desafio') return { ok: false, motivo: 'DESAFIO', detalhe: 'Portal devolveu desafio. Tente 1x de novo.' };
  return { ok: false, motivo: 'BLOQUEADO', detalhe: 'Servidor do PC respondeu algo inesperado.' };
}
