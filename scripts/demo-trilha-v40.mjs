/**
 * demo-trilha-v40 — mostra EXATAMENTE o que aparece no TERMINAL DO VS CODE
 * (onde roda `npx expo start`) quando o app lê uma NFC-e, com o código REAL
 * do app compilado (parsers/nfce.ts + lib/nfcelog.ts).
 *
 * 3 cenas:
 *   A) dígito errado ao digitar a chave  → ETAPA 2 ✗ FALHA na hora (0 s de portal)
 *   B) consulta completa com sucesso     → trilha inteira 1/8…8/8 + VEREDICTO ✓
 *   C) rejeição REAL do firewall F5      → capturada AGORA deste ambiente
 *      ("Request Rejected… Your support ID is: 10138580086094213821") —
 *      é assim que a falha aparece explicada com causa raiz.
 *
 * Uso: node scripts/demo-trilha-v40.mjs
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const P = await import(path.join(here, 'demo-v40', 'parsers', 'nfce.js'));
const L = await import(path.join(here, 'demo-v40', 'lib', 'nfcelog.js'));

const { extractAccessKey, checkAccessKey, nfceKeyDescribe, listConsultUrls, parseNfceHeader, parseNfceItems, isFirewallRejectionPage } = P;
const { nfceBegin, nfceStep, nfceTimer, nfceVerdict, nfceEnvLine, nfceClip, nfceHtmlSummary, nfceBRL, NFCE_STEP } = L;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nota de exemplo no layout CLÁSSICO do portal (mesmos marcadores da real). */
const NOTA_HTML = `<!doctype html><html><head><title>Dados da NFC-e</title></head><body>
<div id="txtDados">
<span class="label">Nome de Fantasia</span><span class="text">MERCADO EXEMPLO LTDA</span>
<span class="label">CNPJ</span><span class="text">57.032.427/0011-60</span>
<span class="label">Data e Hora da Emissão</span><span class="text">31/10/2026 10:12:00</span>
<span class="label">Valor Total</span><span class="text">R$ 38,45</span>
<span class="label">Valor Pago</span><span class="text">R$ 40,00</span>
</div>
<table>
<tr><td><span class="txtTit">LEITE INTEGRAL 1L</span><span class="txtCod">Código do produto: 7894900011517</span>
<span class="Rqtd">Qtde total de itens: 2</span><span class="RUN">Unidade comercial: UN</span><span class="valor">Valor total do item: R$ 15,98</span></td></tr>
<tr><td><span class="txtTit">SABONETE DOVE 90G</span><span class="txtCod">Código do produto: 1234-AB</span>
<span class="Rqtd">Qtde total de itens: 3</span><span class="RUN">Unidade comercial: UN</span><span class="valor">Valor total do item: R$ 14,97</span></td></tr>
<tr><td><span class="txtTit">PÃO FRANCÊS KG</span><span class="txtCod">Código do produto: sem GTIN</span>
<span class="Rqtd">Qtde total de itens: 0,500 kg</span><span class="RUN">Unidade comercial: KG</span><span class="valor">Valor total do item: R$ 7,50</span></td></tr>
</table></body></html>`;

/** Página de rejeição REAL capturada agora (IP deste ambiente recusado pelo F5). */
const REJEICAO_HTML = `<!doctype html><html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.<br><br>Your support ID is: 10138580086094213821</body></html>`;

function banner(titulo) {
  console.log('\n');
  console.log('████████████████████████████████████████████████████████████');
  console.log(`█  CENA ${titulo.padEnd(52)}█`);
  console.log('████████████████████████████████████████████████████████████');
}

/* ── CENA A — dígito errado na chave digitada ─────────────────────────── */
banner('A — dígito errado na chave digitada');
{
  const chaveErrada = '35261057032427001160651100000311141318831363'; // último dígito: 3 (real: 2)
  nfceBegin('colado/digitado', nfceEnvLine('40.0.0'));
  nfceStep(NFCE_STEP.ENTRADA, 'ok', `origem: colado/digitado · conteúdo lido: "${nfceClip(chaveErrada)}"`);
  const accessKey = extractAccessKey(chaveErrada);
  const check = checkAccessKey(accessKey);
  if (!check.ok) {
    nfceStep(NFCE_STEP.CHAVE, 'fail', `chave ${accessKey} — ${check.problems.join(' | ')}`);
    nfceVerdict(false, 'chave de acesso INVÁLIDA — a consulta nem começou', check.problems,
      'confira a chave impressa na nota (44 dígitos) ou escaneie o QR Code de novo');
  }
}

/* ── CENA B — consulta completa com sucesso ───────────────────────────── */
banner('B — consulta completa (trilha 1/8…8/8 + veredito ✓)');
{
  const input = 'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=35261057032427001160651100000311141318831362%7C3%7C1';
  nfceBegin('câmera (QR Code)', nfceEnvLine('40.0.0'));
  nfceStep(NFCE_STEP.ENTRADA, 'ok', `origem: câmera (QR Code) · conteúdo lido: "${nfceClip(input)}"`);
  const accessKey = extractAccessKey(input);
  const check = checkAccessKey(accessKey);
  nfceStep(NFCE_STEP.CHAVE, 'ok', `${accessKey} · ${nfceKeyDescribe(check)}`);
  const candidates = listConsultUrls(input, accessKey);
  nfceStep(NFCE_STEP.CANAIS, 'ok', `${candidates.length} canal(is) na fila — canônico .br sempre 1º`);
  candidates.forEach((u, i) => console.log(`  [NFCE]   canal ${i + 1}: ${nfceClip(u, 140)}`));

  // ETAPA 4 — navegador (tempo real da espera simulada)
  const nav = nfceTimer(NFCE_STEP.NAVEGADOR);
  nfceStep(NFCE_STEP.NAVEGADOR, 'run', `canal 1/${candidates.length} abrindo no motor do aparelho (WebView genuína): ${nfceClip(candidates[0], 120)}`);
  await sleep(320); // desafio F5 + carga (simulado)
  nav.ok(`canal 1/${candidates.length} — página chegou (${nfceHtmlSummary(NOTA_HTML)})`);

  // ETAPA 5 — HTML reconhecido e entregue
  nfceStep(NFCE_STEP.HTML, 'ok', `ENTREGUE ao parser (${nfceHtmlSummary(NOTA_HTML)})`);

  // ETAPA 6 — cabeçalho campo a campo
  const header = parseNfceHeader(NOTA_HTML, accessKey);
  const missing = [];
  if (!header.storeName) missing.push('loja');
  if (!header.cnpj) missing.push('CNPJ');
  if (!header.issuedAt) missing.push('emissão');
  if (header.amountPaidCents == null && header.grossTotalCents == null) missing.push('valor');
  const vals = `loja=${header.storeName ?? 'NÃO ACHOU'} · CNPJ=${header.cnpj ?? 'NÃO ACHOU'} · emissão=${header.issuedAt ?? 'NÃO ACHOU'} · total=${header.amountPaidCents != null ? nfceBRL(header.amountPaidCents) : 'NÃO ACHOU'} (produtos ${nfceBRL(header.grossTotalCents)})`;
  nfceStep(NFCE_STEP.CABECALHO, missing.length === 0 ? 'ok' : 'warn', vals + (missing.length ? ` · FALTOU: ${missing.join(', ')}` : ''));

  // ETAPA 7 — itens + CONFERÊNCIA DE SOMA (centavo exato)
  const items = parseNfceItems(NOTA_HTML);
  const sum = items.reduce((a, r) => a + (r.totalCents ?? 0), 0);
  const semTotal = items.filter((r) => r.totalCents == null).length;
  const semCodigo = items.filter((r) => !r.eanExtracted && !r.storeProductCode).length;
  const noteTotal = header.grossTotalCents ?? header.amountPaidCents;
  const diff = sum - noteTotal;
  const somaOk = Math.abs(diff) <= 1 && semTotal === 0;
  nfceStep(NFCE_STEP.ITENS, somaOk ? 'ok' : 'warn',
    `${items.length} item(ns) extraído(s) · ${semCodigo} sem código · soma dos itens ${nfceBRL(sum)} vs total da nota ${nfceBRL(noteTotal)} — diferença ${nfceBRL(diff)}${somaOk ? ' · CONFERE no centavo' : ' · itens faltando/duplicados?'}`);
  for (const raw of items) {
    console.log(`  [NFCE]     #${raw.lineNumber} ${raw.description} · código=${raw.eanExtracted ?? raw.storeProductCode ?? '?'} · qtd=${raw.qty} ${raw.unitOriginal ?? ''} · total=${nfceBRL(raw.totalCents)}`);
  }

  // ETAPA 8 — resultado
  nfceStep(NFCE_STEP.RESULTADO, 'ok', `LANÇAMENTO CRIADO de ${nfceBRL(header.amountPaidCents)} em 2026-10-31 (${header.storeName})`);
  nfceVerdict(true, `NOTA REGISTRADA — ${items.length} item(ns) · 0 ao estoque · ${items.length} p/ revisão`);
}

/* ── CENA C — rejeição REAL do firewall (capturada agora) ─────────────── */
banner('C — firewall recusou (página REAL capturada neste momento)');
{
  const input = 'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=35261057032427001160651100000311141318831362%7C3%7C1';
  nfceBegin('câmera (QR Code)', nfceEnvLine('40.0.0'));
  nfceStep(NFCE_STEP.ENTRADA, 'ok', `origem: câmera (QR Code) · conteúdo lido: "${nfceClip(input)}"`);
  const accessKey = extractAccessKey(input);
  nfceStep(NFCE_STEP.CHAVE, 'ok', `${accessKey} · ${nfceKeyDescribe(checkAccessKey(accessKey))}`);
  const candidates = listConsultUrls(input, accessKey);
  nfceStep(NFCE_STEP.CANAIS, 'ok', `${candidates.length} canal(is) na fila — canônico .br sempre 1º`);

  // os 3 canais chegam, mas TODOS devolvem a rejeição
  for (let i = 0; i < candidates.length; i++) {
    const t = nfceTimer(NFCE_STEP.NAVEGADOR);
    nfceStep(NFCE_STEP.NAVEGADOR, 'run', `canal ${i + 1}/${candidates.length} abrindo no motor do aparelho: ${nfceClip(candidates[i], 120)}`);
    await sleep(180);
    t.ok(`canal ${i + 1}/${candidates.length} — página chegou (${nfceHtmlSummary(REJEICAO_HTML)})`);
    const rejeitada = isFirewallRejectionPage(REJEICAO_HTML);
    nfceStep(NFCE_STEP.HTML, rejeitada ? 'warn' : 'ok',
      rejeitada ? `REJEIÇÃO do firewall — ${nfceHtmlSummary(REJEICAO_HTML)}` : 'nota reconhecida');
  }
  nfceStep(NFCE_STEP.NAVEGADOR, 'fail', `TODOS os ${candidates.length} canal(is) recusados pelo firewall`);
  nfceVerdict(false, 'TODOS os canais foram recusados pelo firewall da SEFAZ-SP', [
    'firewall bloqueou este acesso/IP — às vezes vale só por alguns minutos (neste demo, o IP do servidor de teste caiu na lista: ONTEM o mesmo link passou)',
    'portal instável ou fora do ar no momento',
  ], 'feche, aguarde um pouco e reescaneie (o histórico repete a nota sem digitar); se persistir, tente pelo Wi-Fi ou mais tarde');
}
