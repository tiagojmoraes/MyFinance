"use strict";
/**
 * nfceLog — v40: DIAGNÓSTICO COMPLETO no terminal do VS Code.
 *
 * Cada consulta NFC-e é reportada como uma TRILHA DE ETAPAS numeradas
 * (1/8…8/8), cada uma com resultado ✓ OK · ⚠ ATENÇÃO · ✗ FALHA, o TEMPO
 * gasto e o detalhe técnico — e no fim um VEREDICTO com a causa raiz
 * provável e o próximo passo. As linhas aparecem DIRETO no terminal onde
 * roda `npx expo start` (Metro mostra o console.log do app em tempo real).
 *
 * ETAPAS (fixas — o usuário aprende a ler):
 *   1 ENTRADA   — origem do dado (câmera QR, colado, histórico)
 *   2 CHAVE     — extração dos 44 dígitos + validação (DV módulo 11, UF,
 *                 AAMM, CNPJ, modelo 65 NFC-e vs 55 NFe)
 *   3 CANAIS    — fila de URLs oficiais em ordem de tentativa
 *   4 NAVEGADOR — abrir a página no motor do aparelho (por canal, com tempo)
 *   5 HTML      — página capturada: tamanho, título, marcadores, decisão
 *   6 CABEÇALHO — parser: loja, CNPJ, emissão, valor (campo a campo)
 *   7 ITENS     — parser: nº de itens + CONFERÊNCIA DE SOMA vs total
 *   8 RESULTADO — persistência: lançamento criado/já existia/sem valor
 *
 * Regras:
 *  - NUNCA lança exceção (log é best-effort — não pode derrubar o fluxo);
 *  - HTML nunca é inteiro no log: só tamanho + título + marcadores
 *    (nfceHtmlSummary), para não poluir nem travar o Metro;
 *  - buffer circular de 400 linhas — o snapshot completo pode ser
 *    compartilhado de Ajustes > Diagnóstico NFC-e.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NFCE_STEP = exports.NFCE_STEP_NAMES = exports.NFCE_TOTAL_STEPS = void 0;
exports.nfceLog = nfceLog;
exports.nfceLogSnapshot = nfceLogSnapshot;
exports.nfceLogClear = nfceLogClear;
exports.nfceMs = nfceMs;
exports.nfceBRL = nfceBRL;
exports.nfceStep = nfceStep;
exports.nfceTimer = nfceTimer;
exports.nfceBegin = nfceBegin;
exports.nfceVerdict = nfceVerdict;
exports.nfceEnvLine = nfceEnvLine;
exports.nfceClip = nfceClip;
exports.nfceHtmlSummary = nfceHtmlSummary;
const MAX_LINES = 400;
const buffer = [];
function nfceLog(message) {
    try {
        const t = new Date();
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const ss = String(t.getSeconds()).padStart(2, '0');
        const line = `[NFCE ${hh}:${mm}:${ss}] ${message}`;
        buffer.push(line);
        if (buffer.length > MAX_LINES)
            buffer.splice(0, buffer.length - MAX_LINES);
        // eslint-disable-next-line no-console
        console.log(line);
    }
    catch {
        // log nunca derruba o app
    }
}
/** Últimas linhas do log (junta com \n) — para tela/compartilhamento. */
function nfceLogSnapshot() {
    return buffer.join('\n');
}
/** Limpa o buffer (ex.: início de uma nova tentativa). */
function nfceLogClear() {
    buffer.length = 0;
}
/** Número fixo de etapas do fluxo (o usuário aprende a ler 1/8…8/8). */
exports.NFCE_TOTAL_STEPS = 8;
/** Rótulos das etapas (mesma ordem do comentário do topo) — índice = nº da etapa - 1. */
exports.NFCE_STEP_NAMES = [
    'ENTRADA',
    'CHAVE',
    'CANAIS',
    'NAVEGADOR',
    'HTML',
    'CABEÇALHO',
    'ITENS',
    'RESULTADO',
];
/** Números das etapas — use nos call sites: nfceStep(NFCE_STEP.CHAVE, 'ok', …). */
exports.NFCE_STEP = {
    ENTRADA: 1,
    CHAVE: 2,
    CANAIS: 3,
    NAVEGADOR: 4,
    HTML: 5,
    CABECALHO: 6,
    ITENS: 7,
    RESULTADO: 8,
};
const STATUS_MARK = {
    ok: '✓ OK',
    warn: '⚠ ATENÇÃO',
    fail: '✗ FALHA',
    run: '… executando',
    info: '·',
};
/** 1234 → "1,2s"; 80 → "0,1s". */
function nfceMs(ms) {
    if (ms == null || !Number.isFinite(ms))
        return '';
    const s = Math.max(0, ms) / 1000;
    return `${s.toFixed(1).replace('.', ',')}s`;
}
/** 41811 → "R$ 418,11" (pt-BR no terminal — vírgula, como no cupom). */
function nfceBRL(cents) {
    if (cents == null || !Number.isFinite(cents))
        return '—';
    const neg = cents < 0 ? '-' : '';
    const abs = Math.abs(Math.round(cents));
    const reais = Math.floor(abs / 100).toString();
    const dec = (abs % 100).toString().padStart(2, '0');
    return `${neg}R$ ${reais},${dec}`;
}
/**
 * v40 — UMA ETAPA da trilha. O rótulo vem do número (NFCE_STEP_NAMES), então
 * a sequência 1/8…8/8 é sempre a mesma, em qualquer módulo do app.
 */
function nfceStep(step, status, detail, elapsedMs) {
    try {
        const name = exports.NFCE_STEP_NAMES[step - 1] ?? `ETAPA ${step}`;
        const parts = [`▸ ETAPA ${step}/${exports.NFCE_TOTAL_STEPS} · ${name} — ${STATUS_MARK[status] ?? '?'}`];
        if (elapsedMs != null)
            parts.push(`(${nfceMs(elapsedMs)})`);
        if (detail)
            parts.push(detail);
        nfceLog(parts.join(' '));
    }
    catch {
        // log nunca derruba o app
    }
}
function nfceTimer(step) {
    const t0 = Date.now();
    return {
        ok: (detail) => nfceStep(step, 'ok', detail, Date.now() - t0),
        warn: (detail) => nfceStep(step, 'warn', detail, Date.now() - t0),
        fail: (detail) => nfceStep(step, 'fail', detail, Date.now() - t0),
    };
}
/**
 * v40 — Abre a trilha de uma consulta: cabeçalho com origem + AMBIENTE
 * (versão do app e relógio do aparelho — relógio errado quebra o TLS).
 */
function nfceBegin(origem, env) {
    try {
        nfceLog('──────────────────────────────────────────────');
        nfceLog(`NOVA CONSULTA NFC-e · origem: ${origem}`);
        if (env)
            nfceLog(env);
        nfceLog('trilha: cada linha é uma etapa com ✓ OK · ⚠ ATENÇÃO · ✗ FALHA e tempo gasto');
        nfceLog('──────────────────────────────────────────────');
    }
    catch {
        // log nunca derruba o app
    }
}
/** Fecha o bloco de uma consulta (usar no fim — sucesso OU falha). */
function nfceVerdict(ok, headline, causes, next) {
    try {
        const bar = ok ? '══════ VEREDICTO: SUCESSO ══════' : '══════ VEREDICTO: FALHA ══════';
        nfceLog(bar);
        nfceLog(ok ? `✔ ${headline}` : `✘ ${headline}`);
        if (!ok && causes && causes.length) {
            nfceLog('causa(s) raiz provável(is):');
            causes.forEach((c, i) => nfceLog(`  ${i + 1}) ${c}`));
        }
        if (next)
            nfceLog(`próximo passo: ${next}`);
        nfceLog('══════════════════════════════');
    }
    catch {
        // log nunca derruba o app
    }
}
/**
 * v40 — Linha de AMBIENTE da consulta: versão do app + RELÓGIO DO APARELHO
 * (relógio errado é causa raiz clássica de erro de certificado SSL).
 * A versão vem de quem chama (expo-constants) para nfcelog ficar puro.
 */
function nfceEnvLine(appVersion) {
    try {
        const t = new Date();
        const p = (n) => String(n).padStart(2, '0');
        const offMin = -t.getTimezoneOffset();
        const sign = offMin >= 0 ? '+' : '-';
        const abs = Math.abs(offMin);
        const tz = `UTC${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
        const clock = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ` +
            `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())} (${tz})`;
        const ver = appVersion ? `app ${appVersion}` : 'app (versão indisponível)';
        return `${ver} · relógio do aparelho ${clock}`;
    }
    catch {
        return 'ambiente indisponível';
    }
}
/** Corta texto longo para o log (uma linha, sem quebra feia no Metro). */
function nfceClip(text, max = 120) {
    const one = text.replace(/\s+/g, ' ').trim();
    return one.length > max ? `${one.slice(0, max)}…` : one;
}
/**
 * Resumo SEGURO de um HTML capturado: tamanho + <title> + marcadores-chave.
 * É esta linha que responde "o que o app recebeu do portal?" —
 * página da nota (clássica/Axure), desafio do firewall ou rejeição.
 */
function nfceHtmlSummary(html) {
    try {
        const kb = Math.max(1, Math.round(html.length / 1024));
        const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
        const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 80) : '(sem título)';
        const marks = [];
        if (/tabResult/i.test(html))
            marks.push('itens-clássico');
        if (/grdItens/i.test(html))
            marks.push('itens-Axure');
        if (/id=["']u20_div["']|id=["']u20["']/i.test(html))
            marks.push('cabeçalho-Axure');
        if (/txtDados|txtTopo/i.test(html))
            marks.push('cabeçalho-clássico');
        if (/Valor\s+(?:Total|a\s+Pagar)/i.test(html))
            marks.push('valor-total');
        if (/Nome\s+Empresarial| Raz[aã]o Social/i.test(html))
            marks.push('razão-social');
        if (isRejectionLike(html))
            marks.push('REJEIÇÃO-FIREWALL');
        if (/APM_DO_NOT_TOUCH|TSPD/i.test(html))
            marks.push('desafio-F5');
        return `${kb} KB · título="${title}" · ${marks.length ? marks.join(', ') : 'nenhum marcador'}`;
    }
    catch {
        return `(resumo falhou, ${html.length} chars)`;
    }
}
/** Réplica barata de isFirewallRejectionPage para o resumo (sem import cíclico). */
function isRejectionLike(html) {
    if (/Valor\s+(?:Total|a\s+Pagar)|Nome\s+Empresarial/i.test(html))
        return false;
    return /requested\s+URL\s+was\s+rejected|Your\s+support\s+ID|Request\s+Rejected|Access\s+Denied/i.test(html);
}
