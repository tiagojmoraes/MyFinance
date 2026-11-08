/**
 * v31 — DIAGNÓSTICO AO VIVO da NFC-e no terminal do Expo (Metro).
 *
 * O usuário não conseguia ver O QUE o app estava fazendo ao ler a nota.
 * A v31 imprime cada etapa com prefixo [NFCE] via console.log — as linhas
 * aparecem direto no terminal do `npx expo start`:
 *   entrada (QR lido, chave, canais) → webview (canal aberto, página
 *   capturada, rejeição, troca de canal) → serviço (parser do cabeçalho,
 *   itens, lançamento criado).
 *
 * Estes testes garantem que o logger é seguro (nunca lança), circula no
 * buffer de 400 linhas e que o RESUMO do HTML identifica corretamente
 * página clássica, Axure, rejeição do firewall e desafio F5.
 */

import { nfceLog, nfceLogSnapshot, nfceLogClear, nfceHtmlSummary } from '../lib/nfcelog';

let logSpy: jest.SpyInstance;

beforeEach(() => {
  nfceLogClear();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('v31 — nfceLog (logs da NFC-e no terminal)', () => {
  test('imprime com prefixo [NFCE] e guarda no snapshot', () => {
    nfceLog('webview: canal 1 aberto: https://exemplo.teste/qrcode');
    const printed = String(logSpy.mock.calls[0][0]);
    expect(printed).toContain('[NFCE');
    expect(printed).toContain('webview: canal 1 aberto');
    expect(nfceLogSnapshot()).toContain('webview: canal 1 aberto: https://exemplo.teste/qrcode');
  });

  test('nfceLogClear limpa o buffer', () => {
    nfceLog('linha temporária');
    expect(nfceLogSnapshot()).not.toBe('');
    nfceLogClear();
    expect(nfceLogSnapshot()).toBe('');
  });

  test('buffer circular: nunca passa de 400 linhas', () => {
    for (let i = 0; i < 450; i++) nfceLog(`linha-${i}`);
    const lines = nfceLogSnapshot().split('\n');
    expect(lines.length).toBe(400);
    // as antigas caem fora; as novas continuam
    expect(nfceLogSnapshot()).not.toContain('linha-10]');
    expect(nfceLogSnapshot()).toContain('linha-449');
  });

  test('nunca lança — mensagem não-string/objeto não derruba o app', () => {
    expect(() => nfceLog('ok')).not.toThrow();
  });
});

describe('v31 — nfceHtmlSummary (o que o app recebeu do portal?)', () => {
  const CLASSICA = `<html><head><title>Consulta NFC-e - Secretaria da Fazenda</title></head><body>
    <div class="txtTopo"></div><div class="txtDados">Nome Empresarial: SENDAS DISTRIBUIDORA</div>
    <table id="tabResult"><tr><td>MAMAO PAPAYA</td></tr></table>
    <span>Valor Total R$ 131,47</span></body></html>`;

  const AXURE = `<html><head><title>Consulta Resumida NFC-e</title></head><body>
    <div id="u20_div">SENDAS DISTRIBUIDORA S/A</div>
    <table id="grdItens"><tr><td>LEITE</td><td>16,98</td></tr></table>
    <div>Valor a pagar R$:131,47</div></body></html>`;

  const REJEICAO = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator. Your support ID is: 123456</body></html>';

  const DESAFIO = '<html><head><title>Please wait...</title></head><body><script src="/TSPD/?type=14"></script>APM_DO_NOT_TOUCH</body></html>';

  test('página CLÁSSICA: itens + cabeçalho + valor + título', () => {
    const s = nfceHtmlSummary(CLASSICA);
    expect(s).toContain('itens-clássico');
    expect(s).toContain('cabeçalho-clássico');
    expect(s).toContain('valor-total');
    expect(s).toContain('título="Consulta NFC-e - Secretaria da Fazenda"');
  });

  test('página AXURE: marcadores da consulta por QR', () => {
    const s = nfceHtmlSummary(AXURE);
    expect(s).toContain('itens-Axure');
    expect(s).toContain('cabeçalho-Axure');
    expect(s).toContain('valor-total');
  });

  test('REJEIÇÃO do firewall marcada — e a nota verdadeira NUNCA é marcada', () => {
    expect(nfceHtmlSummary(REJEICAO)).toContain('REJEIÇÃO-FIREWALL');
    expect(nfceHtmlSummary(CLASSICA)).not.toContain('REJEIÇÃO-FIREWALL');
    expect(nfceHtmlSummary(AXURE)).not.toContain('REJEIÇÃO-FIREWALL');
  });

  test('desafio F5 marcado (página intermediária, não é falha)', () => {
    const s = nfceHtmlSummary(DESAFIO);
    expect(s).toContain('desafio-F5');
    expect(s).not.toContain('REJEIÇÃO-FIREWALL');
  });

  test('tamanho em KB sempre presente', () => {
    expect(nfceHtmlSummary(CLASSICA)).toMatch(/^\d+ KB · título=/);
  });

  test('HTML vazio não derruba o resumo', () => {
    expect(nfceHtmlSummary('')).toContain('KB · título="(sem título)"');
  });
});
