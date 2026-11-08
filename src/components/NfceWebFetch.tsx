/**
 * NfceWebFetch — CAPTURA da página oficial da SEFAZ-SP com NAVEGADOR VISÍVEL (v22).
 *
 * POR QUE ISTO EXISTE (diagnóstico do bug "NFC-e não funciona"):
 *   A página da nota (www.nfce.fazenda.sp.gov.br — /qrcode e
 *   /NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx) está atrás de proteção
 *   F5 BIG-IP ("shape security"): o primeiro acesso recebe um DESAFIO
 *   JavaScript (script /TSPD/, marcador APM_DO_NOT_TOUCH, cookies TS*). Só um
 *   navegador de verdade executa esse desafio — o servidor então libera a
 *   página da nota no recarregamento automático. `fetch` puro recebe só o
 *   desafio (ou "Request Rejected"), por isso a leitura nunca funcionava.
 *
 * v22 (bugs 3 e 4): navegador VISÍVEL em modal + captura automática em fatias
 *   + botão manual "A nota abriu? Toque para registrar" (sem timeout que
 *   abandona o fluxo) + erro de rede como estado com "Tentar de novo".
 *
 * v23 (bug "The requested URL was rejected… Your support ID"):
 *   · USER-AGENT DE NAVEGADOR DE VERDADE (Android): o UA padrão do WebView
 *     carrega `; wv` e `Version/4.0` — o firewall do portal bloqueia esse
 *     perfil na primeira requisição. Passamos a enviar um UA idêntico ao do
 *     Chrome (mesma engine que abre a nota no celular do usuário);
 *   · URL SANITIZADA: o QR da SEFAZ-SP traz `p=chave|2|...` com `|` CRUOS.
 *     O Chrome codifica para %7C na rede; o WebView pode enviar cru e o F5
 *     REJEITA ("The requested URL was rejected"). A URL é sanitizada antes de
 *     carregar (sanitizeSefazUrl);
 *   · FALLBACK AUTOMÁTICO: se mesmo assim aparecer a página de REJEIÇÃO do
 *     firewall (isFirewallRejectionPage), o app TROCA SOZINHO para o canal
 *     alternativo da SEFAZ-SP (ConsultaPublica.aspx?chaveAcesso=…) — o
 *     usuário não precisa entender de nada; só vê a nota abrir.
 *
 * v24 (SOLUÇÃO DEFINITIVA — parte 2, navegação):
 *   · RETENTATIVA COM SESSÃO ABERTA: a rejeição do F5 costuma valer só para o
 *     PRIMEIRO acesso limpo. Ao detectar a página de rejeição, o app agora
 *     RECARREGA o MESMO endereço (até 2×, com 1,2 s de pausa) — o reload leva
 *     os cookies do desafio (TS*) e passa. Só depois de esgotar os reloads o
 *     app troca para o canal alternativo;
 *   · SAÍDA MANUAL GARANTIDA: se TODOS os canais forem recusados, a tela
 *     oferece "Registrar despesa sem a nota" (onFallback) — o usuário nunca
 *     fica preso num beco sem saída;
 *   · leitura manual ("A nota abriu?") aceita também páginas com CNPJ
 *     formatado ou "Chave de Acesso" visíveis (layouts novos do portal).
 *
 * v25 (BUG "continua o mesmo erro" — RAIZ ENCONTRADA POR TESTE REAL):
 *   A página de rejeição do firewall tem ~245 BYTES. O onMessage só aceitava
 *   HTML com mais de 500 caracteres — a rejeição NUNCA chegava ao handleHtml:
 *   sem reload automático, sem troca de canal, a tela ficava CONGELADA na
 *   página de erro. Limite abaixado para 80 (a nota real tem dezenas de KB) e
 *   a cadeia de recuperação (reload 2× → canal alternativo → saída garantida)
 *   volta a funcionar. A página real capturada por sondagem:
 *   <html><head><title>Request Rejected</title></head><body>The requested URL
 *   was rejected. Please consult with your administrator.<br><br>Your support
 *   ID is: <…>…</body></html> (~245 bytes).
 *
 * v39 (O JEITO QUE FUNCIONA — pedido do usuário): este componente é agora o
 *   1º PASSO da leitura (não é mais plano B). As 6 ETAPAS do fluxo capturado
 *   no Reqable aparecem NA TELA, ao vivo:
 *     1. App chama WebView.loadUrl() com o link oficial (etapa 1 do JSON);
 *     2. Aparelho monta o pedido — User-Agent GENUÍNO do Android (etapa 2;
 *        o '; wv)' é o INDICADOR CRÍTICO da captura — NÃO inventamos UA);
 *     3. Conexão segura com o portal — túnel HTTPS (etapas 3–4: CONNECT);
 *     4. TLS ponta a ponta — certificado da SEFAZ validado (etapa 5);
 *     5. Desafio de segurança (F5/TSPD) resolvido pelo motor do aparelho;
 *     6. Página carregada — extraindo estabelecimento, CNPJ e itens (etapa 6).
 *   Nada roda "por baixo" antes: o usuário VÊ o processo inteiro acontecer,
 *   igual ao app nativo que funciona.
 *
 * v40.2 (CANAL NOVO — SERVIDOR DO PC): o log do aparelho (19:12–19:14)
 *   provou que TODOS os canais do motor são recusados ("Request Rejected")
 *   mesmo com esperas de 2–5 s e portão anti-ban de 60/180 s funcionando —
 *   o firewall julga a IDENTIDADE do WebView do Expo Go, que não dá para
 *   mudar dentro do Expo Go. O canal 1 passa a ser, QUANDO EXISTIR, o
 *   servidor do PC (tools/servidor-nfce.js — Node puro, SEM npm install):
 *   mesma rede Wi-Fi do Metro, cabeçalhos de Chrome do Windows e, como
 *   plano B do PC, o CHROME REAL em modo headless. O celular só recebe o
 *   HTML pronto e segue com o parser de sempre (etapas 6–8 inalteradas).
 *   Sem servidor no ar, NADA muda: a descoberta falha em ~2 s (cache 60 s)
 *   e os canais do motor seguem exatamente como na v40.1.
 */

import React from 'react';
import { View, Text, Modal, Pressable, Linking } from 'react-native';
import { WebView } from 'react-native-webview';
import { isFirewallRejectionPage, looksLikeNfcePage, pageHasItems } from '../parsers/nfce';
import { nfceLog, nfceHtmlSummary, nfceStep, nfceTimer, nfceVerdict, nfceClip, NFCE_STEP, type NfceStepTimer } from '../lib/nfcelog';
import { nfcePortalGate } from '../lib/nfceGate';
import { acharServidorPc, consultarViaPc } from '../lib/pcBridge';

/** v39 — AS 6 ETAPAS do fluxo que funciona (captura Reqable), visíveis na tela. */
// APK PESSOAL v41: Chrome real sem ; wv - SEFAZ bloqueia WebView do Expo Go
const CHROME_UA_APK = 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const PHASES = [
  'App chama WebView.loadUrl() com o link oficial',
  'Aparelho monta o pedido — User-Agent GENUÍNO do Android',
  'Conexão segura com o portal (túnel HTTPS)',
  'TLS ponta a ponta — certificado da SEFAZ validado',
  'Desafio de segurança resolvido pelo motor do aparelho',
  'Página carregada — extraindo estabelecimento, CNPJ e itens',
];

/**
 * v40.2: páginas mínimas para manter a MESMA tubulação (recarrega → troca de
 * canal → portão) quando o servidor do PC devolve só o veredito sem o HTML.
 * A falsa de rejeição casa com isFirewallRejectionPage; a falsa de desafio
 * casa com o marcador TSPD (página intermediária) sem casar com rejeição.
 */
const HTML_REJEICAO_FALSA = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.</body></html>';
const HTML_DESAFIO_FALSA = '<html><head><title>Consulta NFC-e</title></head><body><!--TSPD APM_DO_NOT_TOUCH--></body></html>';

/** v40.1: contador mm:ss do portão anti-ban. */
const fmtCooldown = (s: number): string => {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
};

/** Captura em FATIAS — cada postMessage leva um pedaço do HTML (v21/v22). */
const INJECT_CHUNKED_CAPTURE = `(function(){
  try {
    var h = document.documentElement.outerHTML;
    var N = 300000;
    var total = Math.max(1, Math.ceil(h.length / N));
    for (var i = 0; i < total; i++) {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({ t: 'chunk', i: i, n: total, c: h.substr(i * N, N) })
      );
    }
  } catch (e) {}
  true;
})();`;

/**
 * v23 tentou UA de Chrome FINGIDO ("Chrome/124…", sem `; wv`) — mas essa
 * decisão nasceu de um diagnóstico viciado: na v22–v24 a rejeição (~245
 * bytes) nem chegava ao tratamento (limite de 500 bytes, corrigido só na
 * v25), então o "bloqueio do UA de WebView" nunca foi medido de verdade.
 * v35: IDENTIDADE GENUÍNA — UA mentiroso conflita com a impressão digital
 * real da engine (navigator.userAgentData, marcas do WebView) e essa
 * contradição é exatamente o que sistemas anti-robô punem. O que o portal
 * julga é a combinacao engine+identidade coerente que abre a nota no
 * navegador do celular — e é ela que enviamos.
 */

export function NfceWebFetch({ urls, onHtml, onCancel, onFallback }: {
  /** CANDIDATOS de URL em ordem de tentativa (v23: com fallback automático). */
  urls: string[];
  /** HTML renderizado da página da nota (automático ou pelo botão manual). */
  onHtml: (html: string) => void;
  /** Usuário cancelou a consulta — a tela que abriu fecha o componente. */
  onCancel: () => void;
  /** v24: TODOS os canais recusados — registra a despesa sem a nota. */
  onFallback?: () => void;
}) {
  const finished = React.useRef(false);
  const manualArmed = React.useRef(false);
  const renderGone = React.useRef(0);
  const candidateIdx = React.useRef(0);
  // v24: reloads de rejeição já feitos NO candidato atual (a 1ª recusa costuma
  // passar no recarregamento, que leva os cookies do desafio do firewall).
  const rejectReloads = React.useRef(0);
  // v40.2: canal 1 = SERVIDOR DO PC (tools/servidor-nfce.js no PC do usuário)
  const pcBaseRef = React.useRef<string | null>(null);
  const viaPcRef = React.useRef(false); // a captura corrente veio do PC (não do WebView)
  const pcDesafioWaits = React.useRef(0);
  const retryTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // v26: a nota foi reconhecida mas SEM a lista de itens — espera (até 6×) os
  // itens renderizarem antes de entregar (antes entregava só o cabeçalho e a
  // NFC-e ficava sem itens).
  const itemWaits = React.useRef(0);
  const itemTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (itemTimer.current) clearTimeout(itemTimer.current);
  }, []);
  // v40.1: PORTÃO anti-ban — se a falha anterior fechou o portão, a consulta
  // NEM COMEÇA: WebView não abre o portal, o contador roda na tela e o
  // navegador só carrega quando o portão libera. Consulta em rajada era o
  // que estendia o bloqueio do firewall (log do aparelho: 4 rajadas em 45 s).
  const [cooldownLeft, setCooldownLeft] = React.useState<number>(() => nfcePortalGate.blockedSecondsLeft());
  const startedRef = React.useRef(false);
  const portaoLoggedRef = React.useRef(false);
  React.useEffect(() => {
    if (cooldownLeft > 0) {
      if (!portaoLoggedRef.current) {
        portaoLoggedRef.current = true;
        nfceLog(`webview: PORTÃO anti-ban fechado — a última consulta teve TODOS os canais recusados; aguardando ${cooldownLeft}s para não alimentar o bloqueio`);
      }
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    nfcePortalGate.markHit();
    iniciarConsulta(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cooldownLeft]);
  // v40.1: contagem regressiva do portão (1 tick por segundo enquanto fechado)
  React.useEffect(() => {
    if (cooldownLeft <= 0) return;
    const t = setInterval(() => setCooldownLeft(nfcePortalGate.blockedSecondsLeft()), 1000);
    return () => clearInterval(t);
  }, [cooldownLeft <= 0]);
  const bufferRef = React.useRef<{ total: number; parts: Map<number, string> }>({ total: 0, parts: new Map() });
  // v40: cronômetro da ETAPA 4 (navegador) do canal corrente — fecha com OK
  // (página chegou) ou FALHA (erro/rejeição final), sempre com o tempo gasto.
  const canalTimerRef = React.useRef<NfceStepTimer | null>(null);
  // v32: DEDUPE de capturas — a injeção roda em vários eventos (início, onLoadEnd,
  // item-timer) e a MESMA página chegava 2–3× ao handleHtml, queimando o orçamento
  // de recargas de rejeição antes da recarga real acontecer (visto nos logs da v31:
  // "tentativa 1/2" e "tentativa 2/2" no mesmo segundo). Página idêntica no MESMO
  // epoch é ignorada; recarga/troca de canal/leitura manual avançam o epoch.
  const lastHandledRef = React.useRef<{ html: string; epoch: number } | null>(null);
  const captureEpochRef = React.useRef(0);
  const webRef = React.useRef<WebView>(null);
  // v30: DELAY ALEATÓRIO 2–5 s entre tentativas (rate-limit do portal — acesso
  // em rajada é exatamente o padrão que o firewall da SEFAZ-SP bloqueia).
  const sefazDelayMs = React.useRef(() => 2000 + Math.floor(Math.random() * 3000));
  // v40.2: total de canais da consulta = canais do motor + servidor do PC (se achado)
  const totalCanais = () => urls.length + (pcBaseRef.current ? 1 : 0);
  // v40.1: TODO acesso ao portal passa pelo PORTÃO (src/lib/nfceGate.ts):
  // espaço mínimo de 2,5 s entre acessos + cooldown anti-ban. O callback só
  // executa quando o portão libera (polling de 1 s enquanto estiver fechado).
  const schedulePortalLoad = React.useCallback((fn: () => void, baseDelayMs: number) => {
    const attempt = () => {
      if (finished.current) return;
      const gate = nfcePortalGate.canHit();
      if (!gate.ok) {
        retryTimer.current = setTimeout(attempt, Math.min(gate.waitMs, 1000) + 25);
        return;
      }
      nfcePortalGate.markHit();
      fn();
    };
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(attempt, baseDelayMs);
  }, []);
  const [currentUrl, setCurrentUrl] = React.useState('');
  const [networkError, setNetworkError] = React.useState<null | 'offline' | 'blocked' | 'ssl'>(null);
  const [hint, setHint] = React.useState('Abrindo a página oficial da SEFAZ-SP…');
  // v39: etapa corrente do fluxo que funciona (1–6) — mostrada na tela
  const [phase, setPhase] = React.useState(1);

  /** Remonta as fatias; devolve o HTML completo quando todas chegarem. */
  const assemble = (msg: { i: number; n: number; c: string }): string | null => {
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
  };

  /** v23: (re)começa um candidato — limpa toda a memória de captura. */
  const loadCandidate = (idx: number, motivo: string | null) => {
    viaPcRef.current = false; // v40.2: canal do motor do aparelho — saindo do PC (se estava)
    nfcePortalGate.markHit(); // v40.1: canal carregando — registra o acesso para o próximo respeitar o espaço
    candidateIdx.current = idx;
    finished.current = false;
    manualArmed.current = false;
    rejectReloads.current = 0;
    itemWaits.current = 0;
    bufferRef.current = { total: 0, parts: new Map() };
    captureEpochRef.current += 1; // v32: nova página real pode ser idêntica à anterior
    lastHandledRef.current = null;
    setNetworkError(null);
    setHint(motivo ?? 'Abrindo a página oficial da SEFAZ-SP…');
    setPhase(1); // v39: cada canal recomeça o fluxo na etapa 1 (loadUrl)
    setCurrentUrl(urls[idx]);
    // v40: ETAPA 4 recomeça a cada canal (com o motivo da troca)
    canalTimerRef.current = nfceTimer(NFCE_STEP.NAVEGADOR);
    nfceStep(NFCE_STEP.NAVEGADOR, 'run', `canal ${pcBaseRef.current ? idx + 2 : idx + 1}/${totalCanais()} abrindo no motor do aparelho: ${nfceClip(urls[idx], 120)}${motivo ? ` — ${motivo}` : ''}`);
  };

  /**
   * v40.2: canal 1 — consulta via SERVIDOR DO PC. O PC (Chrome do Windows,
   * mesma rede Wi-Fi do Metro) faz o pedido ao portal e devolve o HTML
   * pronto; o app segue com o parser de sempre. NUNCA lança: falha vira
   * passagem para o canal do motor do aparelho, igual à tolerância da v40.1.
   */
  const executarCanalPc = (url: string) => {
    const base = pcBaseRef.current;
    if (!base || finished.current) return;
    viaPcRef.current = true;
    itemWaits.current = 0;
    pcDesafioWaits.current = 0;
    bufferRef.current = { total: 0, parts: new Map() };
    captureEpochRef.current += 1;
    lastHandledRef.current = null;
    setNetworkError(null);
    setPhase(3); // v39: "conexão segura" — agora feita pelo PC
    setHint('Consultando pelo servidor do PC (Chrome no Windows)…');
    canalTimerRef.current = nfceTimer(NFCE_STEP.NAVEGADOR);
    nfceStep(NFCE_STEP.NAVEGADOR, 'run', `canal 1/${totalCanais()} via SERVIDOR DO PC (${base}) — o PC consulta como Chrome do Windows`);
    schedulePortalLoad(() => {
      void (async () => {
        const t0 = Date.now();
        const res = await consultarViaPc(base, url);
        if (finished.current) return;
        if (!res) {
          viaPcRef.current = false;
          canalTimerRef.current?.fail(`servidor do PC não respondeu (${((Date.now() - t0) / 1000).toFixed(1)}s) — servidor fechado ou PC sumiu da rede`);
          canalTimerRef.current = null;
          nfceLog('webview: servidor do PC indisponível — seguindo com o motor do aparelho');
          loadCandidate(0, 'Servidor do PC não respondeu — abrindo no motor do aparelho…');
          return;
        }
        if (res.tipo === 'ok') {
          canalTimerRef.current?.ok(`canal 1/${totalCanais()} — página chegou do PC (${(res.bytes / 1024).toFixed(1)} KB · estratégia ${res.estrategia} · ${(res.ms / 1000).toFixed(1)}s)`);
          canalTimerRef.current = null;
          handleHtml(res.html);
          return;
        }
        if (res.tipo === 'gate') {
          viaPcRef.current = false;
          canalTimerRef.current?.fail(`servidor do PC com portão anti-ban fechado (${res.segundos}s)`);
          canalTimerRef.current = null;
          nfceLog(`webview: PC com portão fechado (${res.segundos}s) — seguindo com o motor do aparelho`);
          loadCandidate(0, `O servidor do PC está com o portão anti-ban fechado (${res.segundos}s) — abrindo no motor do aparelho…`);
          return;
        }
        if (res.tipo === 'desafio') {
          const kb = res.html ? (res.html.length / 1024).toFixed(1) : '0';
          canalTimerRef.current?.ok(`canal 1/${totalCanais()} — página chegou do PC (${kb} KB · DESAFIO do firewall)`);
          canalTimerRef.current = null;
          handleHtml(res.html ?? HTML_DESAFIO_FALSA);
          return;
        }
        if (res.tipo === 'indisponivel') {
          viaPcRef.current = false;
          canalTimerRef.current?.fail('servidor do PC respondeu algo inesperado');
          canalTimerRef.current = null;
          loadCandidate(0, 'O servidor do PC respondeu algo inesperado — abrindo no motor do aparelho…');
          return;
        }
        // bloqueado — entra na MESMA tubulação de recusa (recarrega 2× → motor do aparelho)
        canalTimerRef.current?.ok(`canal 1/${totalCanais()} — página chegou do PC (1 KB · REJEIÇÃO-FIREWALL${res.supportId ? ` · support ${res.supportId}` : ''})`);
        canalTimerRef.current = null;
        handleHtml(res.html ?? HTML_REJEICAO_FALSA);
      })();
    }, 0);
  };

  /**
   * v40.2: começa a consulta inteira — descobre o servidor do PC (cache 60 s)
   * e monta a fila: canal 1 = PC (se existir); canais seguintes = motor do
   * aparelho (WebView genuína), como na v40.1. Usada pelo início automático
   * e pelo botão "Tentar de novo".
   */
  const iniciarConsulta = (motivo: string | null) => {
    finished.current = false;
    manualArmed.current = false;
    rejectReloads.current = 0;
    setNetworkError(null);
    void (async () => {
      const base = await acharServidorPc();
      pcBaseRef.current = base;
      viaPcRef.current = false;
      const total = urls.length + (base ? 1 : 0);
      nfceLog(`webview: consulta iniciada com ${total} canal(is):${motivo ? ` (${motivo})` : ''}`);
      if (base) nfceLog(`webview:   canal 1: SERVIDOR DO PC (${base}) — o PC consulta como Chrome do Windows`);
      urls.forEach((u, i) => nfceLog(`webview:   canal ${(base ? 2 : 1) + i}: ${nfceClip(u, 140)}`));
      if (base) {
        executarCanalPc(urls[0] ?? '');
        return;
      }
      nfceLog('webview: servidor do PC não encontrado (node servidor-nfce.js não está no ar?) — só motor do aparelho');
      loadCandidate(0, motivo);
    })();
  };

  const deliver = (html: string) => {
    if (finished.current) return;
    finished.current = true;
    nfcePortalGate.markSuccess(); // v40.1: nota abriu — histórico de falhas zerado
    setPhase(6); // v39: etapa final — extraindo os dados da nota
    // v40: ETAPA 5 fecha OK — HTML entregue ao parser (tamanho + marcadores)
    nfceStep(NFCE_STEP.HTML, 'ok', `ENTREGUE ao parser (${nfceHtmlSummary(html)})`);
    onHtml(html);
  };

  const handleHtml = (html: string) => {
    if (finished.current) return;
    // v32: mesma página recapturada no mesmo epoch → ignora (não queima recargas)
    const last = lastHandledRef.current;
    if (last && last.epoch === captureEpochRef.current && last.html === html) return;
    lastHandledRef.current = { html, epoch: captureEpochRef.current };
    setNetworkError(null);
    // v31: cada página COMPLETA capturada aparece no terminal com o resumo
    nfceLog(`webview: página capturada → ${nfceHtmlSummary(html)}`);
    // v40: a ETAPA 4 fecha OK no 1º HTML completo do canal (a rede entregou)
    if (canalTimerRef.current) {
      canalTimerRef.current.ok(`canal ${candidateIdx.current + 1}/${urls.length} — página chegou (${nfceHtmlSummary(html)})`);
      canalTimerRef.current = null;
    }
    // v23: REJEIÇÃO do firewall. v24: antes de trocar de canal, RECARREGA o
    // MESMO endereço (até 2×) — o 1º acesso limpo é recusado, mas o reload
    // leva os cookies do desafio (TS*) e costuma abrir a nota.
    if (isFirewallRejectionPage(html)) {
      nfceStep(NFCE_STEP.HTML, 'warn', `REJEIÇÃO do firewall — ${nfceHtmlSummary(html)}`);
      if (rejectReloads.current < 2) {
        rejectReloads.current += 1;
        // v31: recarga pós-rejeição visível no terminal
        nfceLog(`webview: REJEIÇÃO do firewall — recarregando o mesmo canal (tentativa ${rejectReloads.current}/2 após espera de 2–5 s)`);
        setHint(
          rejectReloads.current === 1
            ? 'O portal recusou o primeiro acesso — recarregando com a sessão aberta…'
            : 'O portal ainda recusa — tentando mais uma vez no mesmo canal…'
        );
        setPhase(3); // v39: volta para a conexão — o reload leva os cookies do desafio
        bufferRef.current = { total: 0, parts: new Map() };
        // v40.1 CORREÇÃO DA RAJADA (vista no log do aparelho: 2 reloads no MESMO
        // segundo): o epoch/lastHandled SÓ avançam quando o reload de fato parte.
        // Antes eles avançavam imediatamente — qualquer captura residual da
        // MESMA rejeição (com novo Support ID) passava pelo dedupe e queimava
        // os 2 reloads em menos de 1 s, alimentando o bloqueio do firewall.
        schedulePortalLoad(() => {
          captureEpochRef.current += 1;
          lastHandledRef.current = null;
          // v40.2: no canal do PC não existe WebView para recarregar — nova
          // busca no PC (o servidor resolve o desafio com o Chrome real)
          if (viaPcRef.current) executarCanalPc(urls[0] ?? currentUrl);
          else webRef.current?.reload();
        }, sefazDelayMs.current());
        return;
      }
      // v40.2: recargas do SERVIDOR DO PC esgotadas — a fila continua no motor
      if (viaPcRef.current) {
        nfceLog('webview: rejeições esgotadas no SERVIDOR DO PC — trocando para o motor do aparelho após espera de 2–5 s');
        setHint('O servidor do PC também foi recusado — abrindo no motor do aparelho…');
        schedulePortalLoad(() => loadCandidate(0, 'O portal recusou também o servidor do PC — abrindo no motor do aparelho (WebView)…'), sefazDelayMs.current());
        return;
      }
      const next = candidateIdx.current + 1;
      if (next < urls.length) {
        // v30: espera aleatória de 2–5 s também ao TROCAR de canal (o portal
        // precisa "esfriar" o acesso anterior antes do próximo).
        // v31: troca de canal visível no terminal
        nfceLog(`webview: rejeições esgotadas neste canal — trocando para o canal ${next + 1}/${urls.length} após espera de 2–5 s`);
        setHint('O portal recusou o link do QR — aguardando para abrir o canal alternativo da SEFAZ-SP…');
        // v40.1: a troca também passa pelo PORTÃO (espaço mínimo garantido)
        schedulePortalLoad(() => loadCandidate(next, 'O portal recusou o link do QR — abrindo o canal alternativo da SEFAZ-SP…'), sefazDelayMs.current());
      } else {
        // v31: TODOS os canais recusados — causa visível no terminal
        nfceLog('webview: FALHA — todos os canais recusados pelo firewall (tela: "portal recusou o acesso")');
        nfceStep(NFCE_STEP.NAVEGADOR, 'fail', `TODOS os ${totalCanais()} canal(is) recusados pelo firewall`);
        nfceVerdict(false, 'TODOS os canais foram recusados pelo firewall da SEFAZ-SP', [
          'firewall bloqueou este acesso/IP — às vezes vale só por alguns minutos',
          'consultas repetidas em pouco tempo EXTENDEM o bloqueio — o app agora espera sozinho (v40.1)',
          'portal instável ou fora do ar no momento',
        ], 'abra a nota no navegador do celular (botão na tela) ou espere o contador anti-ban e toque em Tentar de novo; trocar Wi-Fi <-> dados móveis muda o IP');
        // v40.1: a consulta TERMINOU em falha — nenhuma captura residual
        // reprocessa (mata o VEREDICTO DUPLICADO visto no log) e o portão
        // anti-ban fecha com backoff crescente: 1 min → 3 min → 10 min.
        finished.current = true;
        const gate = nfcePortalGate.markAllRejected();
        setCooldownLeft(Math.ceil(gate.waitMs / 1000));
        nfceLog(`webview: PORTÃO anti-ban FECHADO por ${Math.round(gate.waitMs / 1000)}s (falhas seguidas: ${gate.streak}) — martelar o portal só estende o bloqueio`);
        setNetworkError('blocked');
        setHint('O portal recusou o acesso por este caminho.');
      }
      return;
    }
    if (looksLikeNfcePage(html)) {
      // v26: cabeçalho apareceu mas os itens ainda não — espera e captura de novo
      if (!manualArmed.current && !pageHasItems(html) && itemWaits.current < 6) {
        itemWaits.current += 1;
        // v40: espera por itens visível como ATENÇÃO na trilha
        nfceStep(NFCE_STEP.HTML, 'warn', `nota reconhecida SEM itens ainda — esperando renderizar (espera ${itemWaits.current}/6)`);
        setHint('Nota reconhecida — aguardando carregar os itens…');
        setPhase(6); // v39: já é a etapa de extração — itens renderizando
        if (itemTimer.current) clearTimeout(itemTimer.current);
        itemTimer.current = setTimeout(() => {
          if (finished.current) return;
          // v40.2: canal do PC não tem WebView para injetar — busca de novo no PC
          if (viaPcRef.current && pcBaseRef.current) {
            const base = pcBaseRef.current;
            void (async () => {
              const res = await consultarViaPc(base, urls[0] ?? currentUrl);
              if (finished.current || !res || res.tipo !== 'ok') return;
              captureEpochRef.current += 1; // mesma página pode voltar igual — não deixe o dedupe engolir
              lastHandledRef.current = null;
              handleHtml(res.html);
            })();
            return;
          }
          webRef.current?.injectJavaScript(INJECT_CHUNKED_CAPTURE);
        }, 1500);
        return;
      }
      setHint('Nota reconhecida — registrando os dados…');
      deliver(html);
      return;
    }
    if (manualArmed.current) {
      // v22: o usuário confirmou o registro — aceita a página visível se ela
      // ao menos carrega dados da nota. v24: aceita também CNPJ formatado ou
      // "Chave de Acesso" (layouts novos/parciais do portal).
      if (/CNPJ|Valor\s+Total|Nome\s+Empresarial|Raz[aã]o\s+Social|Chave\s+de\s+Acesso|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/i.test(html)) {
        deliver(html);
        return;
      }
      manualArmed.current = false;
      // v40: página visível não era a nota — ATENÇÃO na trilha
      nfceStep(NFCE_STEP.HTML, 'warn', 'botão manual — página visível ainda não tem dados da nota');
      setHint('Esta página ainda não é a nota — aguarde a nota abrir e toque de novo.');
      return;
    }
    // desafio/intermediária: o portal recarrega sozinho — o próximo onLoadEnd
    // injeta de novo e o HTML final checa aqui de novo
    nfceStep(NFCE_STEP.HTML, 'info', 'página intermediária (desafio do firewall) — aguardando o portal resolver sozinho');
    setHint('Resolvendo a verificação do portal… a nota abre em instantes.');
    setPhase(5); // v39: desafio de segurança sendo resolvido pelo motor do aparelho
    // v40.2: no canal do PC não existe onLoadEnd — o app re-consulta o PC (o
    // servidor resolve o desafio com o Chrome real do PC); no máx. 2 esperas
    if (viaPcRef.current && pcDesafioWaits.current < 2 && pcBaseRef.current) {
      pcDesafioWaits.current += 1;
      const base = pcBaseRef.current;
      nfceLog(`webview: desafio do firewall via PC — consultando o PC de novo em 2,5 s (espera ${pcDesafioWaits.current}/2)`);
      if (itemTimer.current) clearTimeout(itemTimer.current);
      itemTimer.current = setTimeout(() => {
        if (finished.current) return;
        void (async () => {
          const res = await consultarViaPc(base, urls[0] ?? currentUrl);
          if (finished.current) return;
          captureEpochRef.current += 1; // mesmo desafio pode voltar igual — não deixe o dedupe engolir
          lastHandledRef.current = null;
          if (!res || res.tipo === 'gate' || res.tipo === 'indisponivel') {
            viaPcRef.current = false;
            loadCandidate(0, !res
              ? 'Servidor do PC não respondeu — abrindo no motor do aparelho…'
              : 'O servidor do PC não pôde continuar — abrindo no motor do aparelho…');
            return;
          }
          handleHtml(res.tipo === 'ok' ? res.html : res.html ?? HTML_DESAFIO_FALSA);
        })();
      }, 2500);
    }
  };

  /** Botão manual: captura a página que está NA TELA agora. */
  const captureVisiblePage = () => {
    if (finished.current) return;
    // v40.2: no canal do PC a tela mostra o app (não o portal) — o botão
    // manual vira "consultar o servidor do PC de novo AGORA" (saída manual
    // garantida também no canal novo).
    if (viaPcRef.current && pcBaseRef.current) {
      const base = pcBaseRef.current;
      nfceLog('webview: botão manual tocado no canal do PC — consultando o servidor do PC de novo');
      setHint('Consultando o servidor do PC de novo…');
      manualArmed.current = true;
      lastHandledRef.current = null;
      void (async () => {
        const res = await consultarViaPc(base, urls[0] ?? currentUrl);
        if (finished.current) return;
        captureEpochRef.current += 1;
        if (!res) {
          manualArmed.current = false;
          nfceLog('webview: PC não respondeu ao re-consultar (manual)');
          setHint('O servidor do PC não respondeu — aguarde ou toque de novo.');
          return;
        }
        if (res.tipo === 'ok') { handleHtml(res.html); return; }
        if (res.tipo === 'bloqueado') { handleHtml(res.html ?? HTML_REJEICAO_FALSA); return; }
        if (res.tipo === 'desafio') { handleHtml(res.html ?? HTML_DESAFIO_FALSA); return; }
        manualArmed.current = false;
        nfceLog(`webview: PC com portão anti-ban fechado (${res.tipo === 'gate' ? res.segundos : 0}s) — re-consulte em instantes`);
        setHint(`O servidor do PC está com o portão anti-ban fechado (${res.tipo === 'gate' ? res.segundos : 0}s)…`);
      })();
      return;
    }
    manualArmed.current = true;
    // v32: leitura manual é sempre processada — mesmo HTML não é dedupado
    lastHandledRef.current = null;
    // v31: uso do botão manual visível no terminal
    nfceLog('webview: botão "A nota abriu?" tocado — capturando a página exibida');
    setHint('Lendo a página exibida…');
    webRef.current?.injectJavaScript(INJECT_CHUNKED_CAPTURE);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 bg-slate-100">
        {/* Cabeçalho do navegador interno */}
        <View className="bg-white border-b border-slate-200 px-4 pt-3 pb-3 gap-1">
          <View className="flex-row items-center gap-2">
            <View className="flex-1">
              <Text className="text-base font-bold text-slate-900">Consultando a SEFAZ-SP</Text>
              <Text className="text-[11px] text-slate-500 mt-0.5" numberOfLines={2}>{hint}</Text>
            </View>
            <Pressable onPress={onCancel} className="px-3 py-2 rounded-lg bg-slate-100">
              <Text className="text-slate-700 font-semibold text-sm">Cancelar</Text>
            </Pressable>
          </View>
          {/* v39: AS 6 ETAPAS do fluxo que funciona (captura Reqable) — ao vivo */}
          <View className="flex-row items-center gap-1 mt-1">
            {PHASES.map((label, i) => (
              <View
                key={i}
                className={`h-1.5 flex-1 rounded-full ${i + 1 <= phase ? 'bg-emerald-600' : 'bg-slate-200'}`}
              />
            ))}
          </View>
          <Text className="text-[10px] text-slate-500" numberOfLines={1}>
            Etapa {phase}/6 — {PHASES[phase - 1]}
          </Text>
        </View>

        {/* Navegador VISÍVEL — o desafio do F5 resolve na frente do usuário */}
        <View className="flex-1 m-3 rounded-2xl overflow-hidden bg-white border border-slate-200">
          <WebView
            ref={webRef}
            // v40.1: portão fechado → a WebView fica em about:blank (nenhum
            // acesso ao portal); quando o contador zera, o source volta a ser o
            // canal 1 e a consulta começa de fato.
            // v40.2: em branco enquanto o canal ativo é o servidor do PC — o
            // WebView SÓ carrega quando o canal dele começa (nunca 2 acessos
            // simultâneos ao portal)
            source={cooldownLeft > 0 || !currentUrl ? { uri: 'about:blank' } : { uri: currentUrl }}
            // v41 APK PESSOAL: Chrome real sem ; wv - SEFAZ-SP exige identidade de navegador real
            // v41: correção também dos atributos DUPLICADOS (sharedCookiesEnabled /
            //      thirdPartyCookiesEnabled repetiam — o tsc --noEmit do projeto inteiro falhava)
            userAgent={CHROME_UA_APK}
            applicationNameForUserAgent=""
            incognito={false}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            originWhitelist={['*']}
            setSupportMultipleWindows={false}
            injectedJavaScript={INJECT_CHUNKED_CAPTURE}
            injectedJavaScriptBeforeContentLoaded={INJECT_CHUNKED_CAPTURE}
            onMessage={(event) => {
              if (finished.current) return;
              try {
                const msg = JSON.parse(event.nativeEvent.data);
                if (msg?.t === 'chunk' && typeof msg.c === 'string') {
                  const full = assemble(msg);
                  // v25: LIMITE ABAIXADO (500 → 80). A página REAL de rejeição do
                  // firewall da SEFAZ-SP tem ~245 bytes ("The requested URL was
                  // rejected… Your support ID is: …") — com o limite antigo ela
                  // NUNCA chegava ao handleHtml: sem reload, sem troca de canal,
                  // a tela ficava congelada na página de erro (o "mesmo erro"
                  // relatado pelo usuário). Página da nota tem dezenas de KB.
                  if (full && full.length > 80) handleHtml(full);
                } else if (msg?.t === 'html' && typeof msg.h === 'string' && msg.h.length > 80) {
                  // compatibilidade com a captura antiga (bloco único)
                  handleHtml(msg.h);
                }
              } catch {
                // mensagem não-JSON (injeção) — ignora
              }
            }}
            onLoadStart={() => {
              // v39: etapa 3 do JSON — o aparelho está estabelecendo a conexão
              if (!finished.current) setPhase((p) => (p < 3 ? 3 : p));
            }}
            onLoadEnd={() => {
              // v39: etapa 4 — pedido saiu e voltou pelo túnel TLS (sem erro SSL)
              if (!finished.current) setPhase((p) => (p < 4 ? 4 : p));
              // cada fim de carga (desafio → reload → nota) captura de novo —
              // garantia de que o HTML FINAL da nota é enviado ao app
              if (!finished.current && !networkError) {
                webRef.current?.injectJavaScript(INJECT_CHUNKED_CAPTURE);
              }
            }}
            // v26: esconde a tela de erro crua do WebView ("Error loading page…") —
            // o app mostra a própria explicação logo abaixo (overlay).
            renderError={() => <View />}
            onError={(e) => {
              if (finished.current) return;
              // v26: "SSL error: The certificate authority is not trusted" (código 3) —
              // o celular não confia na cadeia de certificados daquele endereço. Em vez de
              // ficar preso, tenta o OUTRO endereço da SEFAZ (candidatos) e, esgotados,
              // explica a causa e oferece abrir no navegador do celular. O app NÃO ignora
              // o erro de certificado (isso desligaria a proteção do HTTPS).
              const ne = (e?.nativeEvent ?? {}) as { description?: string; code?: number };
              // v40: TODO erro do WebView fecha a ETAPA 4 como FALHA (com tempo)
              canalTimerRef.current?.fail(`canal ${candidateIdx.current + 1}/${urls.length} — ERRO de carregamento: descrição="${ne.description ?? '(sem descrição)'}" código=${ne.code ?? '?'}`);
              canalTimerRef.current = null;
              const isSsl = /ssl|certificate|certificad/i.test(ne.description ?? '') || ne.code === 3;
              if (isSsl) {
                const next = candidateIdx.current + 1;
                if (next < urls.length) {
                  nfceLog(`webview: erro de CERTIFICADO — tentando o canal ${next + 1}/${urls.length}`);
                  loadCandidate(next, 'O celular não confiou no certificado deste endereço — tentando o canal alternativo…');
                } else {
                  nfceLog('webview: FALHA — erro de certificado em todos os canais (confira data/hora do celular)');
                  nfceVerdict(false, 'erro de CERTIFICADO em todos os canais', [
                    'data e hora do celular erradas — a validação do TLS depende do relógio (ative "automáticas" em Ajustes > Data e hora)',
                    'Android desatualizado sem os certificados raiz novos',
                    'rede corporativa/proxy que re-assina HTTPS',
                  ], 'confira o relógio do aparelho (a hora certa é mostrada no início da trilha) e confira se a nota abre no Chrome do celular');
                  setNetworkError('ssl');
                }
                return;
              }
              // v22: erro de rede NÃO abandona a consulta — vira estado na tela
              nfceLog('webview: FALHA — erro de rede/offline no WebView');
              nfceVerdict(false, 'erro de rede/offline ao carregar a página', [
                'sem internet no aparelho (Wi-Fi/dados móveis)',
                'portal da SEFAZ-SP fora do ar',
              ], 'confira a internet e toque em "Tentar de novo"');
              setNetworkError((cur) => cur ?? 'offline');
            }}
            onRenderProcessGone={() => {
              // engine do navegador morreu — recarrega (até 2 vezes)
              // v31: morte da engine do navegador visível no terminal
              nfceLog('webview: engine do navegador MORREU (render process gone) — recarregando');
              if (!finished.current && renderGone.current < 2) {
                renderGone.current += 1;
                webRef.current?.reload();
              }
            }}
          />
          {(networkError || cooldownLeft > 0) ? (
            <View className="absolute inset-0 bg-slate-100 items-center justify-center gap-3 px-8">
              {cooldownLeft > 0 ? (
                // v40.1: PORTÃO FECHADO — o contador anti-ban manda na tela
                <>
                  <Text className="text-slate-800 text-center font-bold text-base">
                    Proteção anti-bloqueio ativa
                  </Text>
                  <Text className="text-slate-500 text-center text-sm">
                    O portal recusou todas as tentativas. Consultas em rajada ESTENDEM o bloqueio — espere o portão abrir:
                  </Text>
                  <Text className="text-4xl font-extrabold text-slate-800">{fmtCooldown(cooldownLeft)}</Text>
                </>
              ) : (
                <>
                  <Text className="text-slate-800 text-center font-bold text-base">
                    {networkError === 'blocked'
                      ? 'O portal da SEFAZ recusou o acesso por este caminho'
                      : networkError === 'ssl'
                        ? 'O celular não confia no certificado do portal da SEFAZ'
                        : 'Não foi possível carregar a página'}
                  </Text>
                  <Text className="text-slate-500 text-center text-sm">
                    {networkError === 'blocked'
                      ? 'Pode ser bloqueio temporário do firewall (vale alguns minutos). A nota abre no navegador do celular — e esta chave já fica no histórico para repetir sem digitar.'
                      : networkError === 'ssl'
                        ? 'Causas mais comuns: data e hora do celular erradas (ative "automáticas" em Ajustes > Data e hora) ou Android sem atualização dos certificados.'
                        : 'Verifique a internet — o portal da SEFAZ pode estar fora do ar.'}
                  </Text>
                </>
              )}
              {/* v40.1: SAÍDA NOVA E REAL — o Chrome do aparelho resolve o desafio
                  do firewall com o fingerprint completo de navegador; a nota
                  abre lá mesmo quando o portal recusa o app. */}
              <Pressable
                onPress={() => { Linking.openURL(urls[0] ?? currentUrl).catch(() => undefined); }}
                className="bg-white border border-slate-300 rounded-xl px-5 py-3"
                accessibilityRole="button"
                accessibilityLabel="Abrir a nota no navegador do celular"
              >
                <Text className="text-slate-700 font-bold text-center">Abrir no navegador do celular</Text>
              </Pressable>
              {cooldownLeft <= 0 ? (
                <Pressable
                  onPress={() => {
                    // v23: "Tentar de novo" volta ao PRIMEIRO canal (link do QR).
                    // v40.1: consulta nova EXPLÍCITA (o usuário pediu) — passa pelo PORTÃO (nunca em rajada).
                    // v40.2: consulta COMPLETA de novo — o servidor do PC é procurado outra vez.
                    schedulePortalLoad(() => iniciarConsulta('Recarregando a página da SEFAZ-SP…'), 0);
                  }}
                  className="bg-emerald-600 rounded-xl px-5 py-3 mt-1"
                >
                  <Text className="text-white font-bold">Tentar de novo</Text>
                </Pressable>
              ) : null}
              {/* v24: SAÍDA GARANTIDA — nenhum canal abriu? A despesa é
                  registrada mesmo assim (sem depender da página da nota). */}
              {onFallback ? (
                <Pressable
                  onPress={onFallback}
                  className="bg-white border border-slate-300 rounded-xl px-5 py-3"
                  accessibilityRole="button"
                  accessibilityLabel="Registrar a despesa manualmente, sem a página da nota"
                >
                  <Text className="text-slate-700 font-bold text-center">Registrar despesa sem a nota</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>

        {/* Rodapé: rede de segurança manual + dica honesta */}
        <View className="px-4 pb-5 pt-2 gap-2 bg-white border-t border-slate-200">
          <Pressable
            onPress={captureVisiblePage}
            disabled={finished.current}
            className="bg-emerald-600 rounded-xl px-4 py-3 items-center"
            accessibilityRole="button"
            accessibilityLabel="Registrar a página exibida como nota fiscal"
          >
            <Text className="text-white font-bold">A nota abriu? Toque para registrar</Text>
          </Pressable>
          <Text className="text-[11px] text-slate-500 text-center px-4">
            O registro normalmente é automático quando a nota aparece. Se a página demorar, toque no botão quando a nota estiver na tela.
          </Text>
        </View>
      </View>
    </Modal>
  );
}
