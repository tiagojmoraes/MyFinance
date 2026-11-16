import React from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import {
  nfceWebEngine,
  decideCaptureAction,
  isGenuineWebViewUa,
  CHALLENGE_MAX_WAITS,
  UNKNOWN_MAX_WAITS,
  type NfceWebEngineDriver,
  type NfceWebEngineResult,
} from '../services/NfceWebEngine';
import { nfceLog, nfceHtmlSummary, nfceStep, nfceTimer, nfceClip, NFCE_STEP, type NfceStepTimer } from '../lib/nfcelog';

const INJECT_CHUNKED_CAPTURE = `(function(){
  try {
    var h = document.documentElement.outerHTML;
    var N = 200000;
    var total = Math.max(1, Math.ceil(h.length / N));
    for (var i = 0; i < total; i++) {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({ t: 'chunk', i: i, n: total, c: h.substr(i * N, N) })
      );
    }
  } catch (e) {}
  true;
})();`;

const SETTLE_MS = 1200;
const MIN_HTML_CHARS = 80;

const INJECT_UA_SNAPSHOT = `(function(){
  try {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
      JSON.stringify({ t: 'ua', ua: navigator.userAgent })
    );
  } catch (e) {}
  true;
})();`;

// APK FINAL: Chrome real sem ; wv - SEFAZ-SP bloqueia WebView do Expo Go
const CHROME_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

interface ActiveJob {
  url: string;
  resolve: (result: NfceWebEngineResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
  challengeWaits: number;
  unknownWaits: number;
  renderGone: number;
}

export function NfceWebEngineView() {
  const webRef = React.useRef<WebView | null>(null);
  const jobRef = React.useRef<ActiveJob | null>(null);
  const canalTimerRef = React.useRef<NfceStepTimer | null>(null);
  const captureTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const uaSentRef = React.useRef(false);
  const bufferRef = React.useRef<{ total: number; parts: Map<number, string> }>({ total: 0, parts: new Map() });
  const [jobUrl, setJobUrl] = React.useState<string | null>(null);

  const finishJob = React.useCallback((result: NfceWebEngineResult | null) => {
    const job = jobRef.current;
    if (!job) return;
    if (captureTimer.current) {
      clearTimeout(captureTimer.current);
      captureTimer.current = null;
    }
    clearTimeout(job.timer);
    jobRef.current = null;
    bufferRef.current = { total: 0, parts: new Map() };
    setJobUrl(null);
    job.resolve(result);
  }, []);

  const scheduleCapture = React.useCallback((delayMs: number, motivo: string) => {
    if (captureTimer.current) clearTimeout(captureTimer.current);
    captureTimer.current = setTimeout(() => {
      if (!jobRef.current) return;
      nfceLog(`motor: injetando captura do DOM (${motivo})…`);
      webRef.current?.injectJavaScript(INJECT_CHUNKED_CAPTURE);
    }, delayMs);
  }, []);

  const onCapturedHtml = React.useCallback((html: string) => {
    const job = jobRef.current;
    if (!job) return;
    if (html.length < MIN_HTML_CHARS) return;
    if (canalTimerRef.current) {
      canalTimerRef.current.ok(`página chegou (${nfceHtmlSummary(html)})`);
      canalTimerRef.current = null;
    }
    const decision = decideCaptureAction(html);
    nfceLog(
      `motor: página capturada → ${nfceHtmlSummary(html)} · decisão=` +
        (decision.action === 'deliver' ? 'É A NOTA — entregar'
          : decision.action === 'hand-over' ? `rejeição do firewall (${decision.kind}) — passar ao canal seguinte`
          : `aguardar (${decision.kind})`)
    );
    if (decision.action === 'deliver') {
      nfceStep(NFCE_STEP.HTML, 'ok', 'página da NOTA reconhecida — entregando ao serviço');
    } else if (decision.action === 'hand-over') {
      nfceStep(NFCE_STEP.HTML, 'warn', `rejeição do firewall (${decision.kind}) — o serviço passa ao canal seguinte`);
    } else {
      nfceStep(NFCE_STEP.HTML, 'info', `aguardando (${decision.kind}) — recaptura em ${Math.round(decision.delayMs / 100) / 10}s`);
    }
    if (decision.action === 'deliver' || decision.action === 'hand-over') {
      finishJob({ html, url: job.url });
      return;
    }
    const max = decision.kind === 'challenge' ? CHALLENGE_MAX_WAITS : UNKNOWN_MAX_WAITS;
    const done = decision.kind === 'challenge' ? job.challengeWaits : job.unknownWaits;
    if (done >= max) {
      nfceLog(`motor: esperas esgotadas (${decision.kind} ${done}/${max}) — entregando o que temos ao serviço`);
      finishJob({ html, url: job.url });
      return;
    }
    if (decision.kind === 'challenge') job.challengeWaits += 1;
    else job.unknownWaits += 1;
    scheduleCapture(decision.delayMs, `recaptura pós-${decision.kind}`);
  }, [finishJob, scheduleCapture]);

  const assemble = React.useCallback((msg: { i: number; n: number; c: string }): string | null => {
    const buf = bufferRef.current;
    if (msg.n !== buf.total) {
      buf.total = msg.n;
      buf.parts = new Map();
    }
    buf.parts.set(msg.i, msg.c);
    if (buf.parts.size < buf.total) return null;
    let out = '';
    for (let i = 0; i < buf.total; i++) out += buf.parts.get(i) ?? '';
    buf.total = 0;
    buf.parts = new Map();
    return out;
  }, []);

  const readJob = React.useCallback(
    (url: string, timeoutMs: number): Promise<NfceWebEngineResult | null> => {
      return new Promise((resolve) => {
        if (jobRef.current) {
          nfceLog('motor: já há uma consulta em andamento — pedido devolvido (o serviço segue a cadeia)');
          resolve(null);
          return;
        }
        canalTimerRef.current = nfceTimer(NFCE_STEP.NAVEGADOR);
        nfceStep(NFCE_STEP.NAVEGADOR, 'run', `abrindo a página no motor do aparelho (WebView Chrome): ${nfceClip(url, 120)}`);
        const timer = setTimeout(() => {
          nfceLog('motor: TEMPO ESGOTADO esperando a página (timeout do trabalho)');
          canalTimerRef.current?.fail(`timeout de ${Math.round(timeoutMs / 1000)}s esperando a página`);
          canalTimerRef.current = null;
          finishJob(null);
        }, timeoutMs);
        jobRef.current = { url, resolve, timer, challengeWaits: 0, unknownWaits: 0, renderGone: 0 };
        uaSentRef.current = false;
        bufferRef.current = { total: 0, parts: new Map() };
        setJobUrl(url);
      });
    },
    [finishJob]
  );

  React.useEffect(() => {
    const driver: NfceWebEngineDriver = { read: (url, timeoutMs) => readJob(url, timeoutMs) };
    nfceWebEngine.attach(driver);
    return () => {
      nfceWebEngine.detach(driver);
      const job = jobRef.current;
      if (job) {
        clearTimeout(job.timer);
        jobRef.current = null;
        job.resolve(null);
      }
      if (captureTimer.current) {
        clearTimeout(captureTimer.current);
        captureTimer.current = null;
      }
    };
  }, [readJob]);

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', width: 1, height: 1, opacity: 0.01, overflow: 'hidden' }}
    >
      {jobUrl ? (
        <WebView
          ref={webRef}
          source={{ uri: jobUrl }}
          style={{ width: 1, height: 1 }}
          // APK FINAL: identidade Chrome Mobile real sem ; wv - SEFAZ-SP exige isso
          userAgent={CHROME_UA}
          applicationNameForUserAgent=""
          javaScriptEnabled
          domStorageEnabled
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
          originWhitelist={['*']}
          setSupportMultipleWindows={false}
          injectedJavaScript={INJECT_CHUNKED_CAPTURE}
          onMessage={(event) => {
            if (!jobRef.current) return;
            try {
              const msg = JSON.parse(event.nativeEvent.data);
              if (msg?.t === 'chunk' && typeof msg.c === 'string') {
                const full = assemble(msg);
                if (full) onCapturedHtml(full);
              } else if (msg?.t === 'ua' && typeof msg.ua === 'string') {
                if (isGenuineWebViewUa(msg.ua)) {
                  nfceLog(`motor: identidade ENVIADA ao portal (WebView genuína — confere com o app que funciona): ${msg.ua}`);
                } else {
                  nfceLog(`motor: identidade Chrome Mobile (APK) enviada: ${msg.ua}`);
                }
              }
            } catch {}
          }}
          onLoadEnd={() => {
            if (!jobRef.current) return;
            if (!uaSentRef.current) {
              uaSentRef.current = true;
              webRef.current?.injectJavaScript(INJECT_UA_SNAPSHOT);
            }
            scheduleCapture(SETTLE_MS, 'página assentada');
          }}
          onError={(e) => {
            if (!jobRef.current) return;
            const ne = (e?.nativeEvent ?? {}) as { description?: string; code?: number };
            nfceLog(`motor: ERRO de carregamento — descrição="${ne.description ?? '(sem descrição)'}" código=${ne.code ?? '?'}`);
            canalTimerRef.current?.fail(`ERRO de carregamento: "${ne.description ?? '(sem descrição)'}" código=${ne.code ?? '?'}`);
            canalTimerRef.current = null;
            finishJob(null);
          }}
          onRenderProcessGone={() => {
            const job = jobRef.current;
            if (!job) return;
            if (job.renderGone < 2) {
              job.renderGone += 1;
              nfceLog('motor: engine do navegador morreu — recarregando');
              webRef.current?.reload();
            } else {
              nfceLog('motor: engine morreu de novo — trabalho devolvido como falha');
              finishJob(null);
            }
          }}
          renderError={() => <View />}
        />
      ) : null}
    </View>
  );
}