/**
 * v32 — LEITURA DIRETA da NFC-e como CAMINHO PRINCIPAL.
 *
 * Os logs da v31 (no celular real do usuário) mostraram: o firewall F5/BIG-IP
 * da SEFAZ-SP rejeita 100% das requisições do WebView embutido do Expo
 * ("Request Rejected" nos 2 canais vivos), enquanto um cliente HTTP SIMPLES
 * com cabeçalhos de navegador recebe a página completa — a sonda PowerShell
 * do usuário (HTTP 200, ~25 KB nos 2 canais) e o código de referência
 * (axios/fetch, "foi de primeira") provam isso.
 *
 * Mudanças cobertas aqui:
 *  · buildSpQrUrl: link do QR montado da chave com p=chave|3|1 COMPLETO
 *    (exigência do usuário: "a chave ... |3|1 completa que deve constar na
 *    requisição") — e é o 1º candidato quando só a chave está disponível;
 *  · legado consultacompleta.aspx FORA da fila (sem resposta no PC, erro de
 *    certificado no celular);
 *  · ingestByDirectFetch: fetch direto primeiro; devolve html para itens;
 *    null → a tela abre o navegador interno (plano B).
 */

import { makeCtx } from './helpers';
import { SEFAZ_RETRY_DELAY } from '../services/NfceService';
import {
  buildSpQrUrl,
  buildSpConsultUrl,
  buildLegacyConsultUrl,
  listConsultUrls,
} from '../parsers/nfce';

const KEY = '35260514214169000187650010000012341234567890';

const PAGE = `<html><head><title>Consulta NFC-e - Secretaria da Fazenda</title></head><body>
  <div class="txtDados">Nome Empresarial: SENDAS DISTRIBUIDORA S/A</div>
  <div>CNPJ: 06.057.223/0508-61</div>
  <div>Valor Total: R$ 131,47</div>
</body></html>`;

const REJEICAO = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Your support ID is: 7</body></html>';

describe('v32 — fila de canais da leitura direta', () => {
  test('buildSpQrUrl monta o p=chave|3|1 COMPLETO (igual ao QR impresso da nota)', () => {
    expect(buildSpQrUrl(KEY)).toBe(
      `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${KEY}%7C3%7C1`
    );
  });

  test('chave colada sem URL: QR completo primeiro, portal público depois', () => {
    const urls = listConsultUrls(KEY, KEY);
    expect(urls[0]).toBe(buildSpQrUrl(KEY));
    expect(urls[1]).toBe(buildSpConsultUrl(KEY));
  });

  test('legado consultacompleta.aspx NÃO entra mais na fila (canal morto)', () => {
    expect(listConsultUrls(KEY, KEY)).not.toContain(buildLegacyConsultUrl(KEY));
  });

  // v39.1 (experiência com o cupom Fonseca): canônico .br sempre 1º; a URL
  // escaneada (mesmo sendo variante /qrcode) fica de reserva; portal público no fim.
  test('URL escaneada variante: canônico .br 1º, escaneada de reserva, público no fim', () => {
    const urls = listConsultUrls(`https://www.nfce.fazenda.sp.gov.br/qrcode?p=${KEY}|3|1`, KEY);
    expect(urls[0]).toBe(buildSpQrUrl(KEY));
    expect(urls).toContain(`https://www.nfce.fazenda.sp.gov.br/qrcode?p=${KEY}%7C3%7C1`);
    expect(urls[urls.length - 1]).toBe(buildSpConsultUrl(KEY));
    expect(urls).toHaveLength(3);
  });
});

describe('v32 — ingestByDirectFetch (mesma estratégia do código que funcionou)', () => {
  let fetchMock: jest.Mock;
  const htmlResponse = (html: string, status = 200) =>
    new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    SEFAZ_RETRY_DELAY.minMs = 0;
    SEFAZ_RETRY_DELAY.maxMs = 0;
  });
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  test('página OK no canal QR → registra TUDO sem abrir navegador (html vem junto p/ itens)', async () => {
    const { services } = await makeCtx();
    fetchMock.mockResolvedValueOnce(htmlResponse(PAGE));
    const res = await services.nfce.ingestByDirectFetch(KEY);
    expect(res).not.toBeNull();
    expect(res!.created).toBe(true);
    expect(res!.transactionId).toBeTruthy();
    expect(res!.html).toContain('SENDAS DISTRIBUIDORA');
    // 1º canal é o QR montado com p=chave|3|1 completo
    expect(String(fetchMock.mock.calls[0][0])).toContain('ConsultaQRCode.aspx?p=');
    expect(String(fetchMock.mock.calls[0][0])).toContain('%7C3%7C1');
  });

  test('canal QR rejeitado pelo firewall → portal público entrega (2 chamadas)', async () => {
    const { services } = await makeCtx();
    fetchMock
      .mockResolvedValueOnce(htmlResponse(REJEICAO))
      .mockResolvedValueOnce(htmlResponse(PAGE));
    const res = await services.nfce.ingestByDirectFetch(KEY);
    expect(res).not.toBeNull();
    expect(res!.created).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('ConsultaPublica.aspx?chaveAcesso=');
  });

  test('TODOS os canais rejeitados → null (a tela abre o navegador interno, plano B)', async () => {
    const { services } = await makeCtx();
    fetchMock.mockResolvedValue(htmlResponse(REJEICAO));
    const res = await services.nfce.ingestByDirectFetch(KEY);
    expect(res).toBeNull();
  });

  test('nota já registrada → devolve a transação existente SEM fetch nenhum', async () => {
    const { services } = await makeCtx();
    fetchMock.mockResolvedValueOnce(htmlResponse(PAGE));
    const first = await services.nfce.ingestByDirectFetch(KEY);
    expect(first!.created).toBe(true);
    fetchMock.mockClear();
    const second = await services.nfce.ingestByDirectFetch(KEY);
    expect(second!.created).toBe(false);
    expect(second!.transactionId).toBe(first!.transactionId);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('reprocessamento com documento podre (PENDING) ainda funciona pelo caminho direto', async () => {
    const { services } = await makeCtx();
    // 1ª tentativa: todos os canais falham → documento PENDING
    fetchMock.mockResolvedValue(htmlResponse(REJEICAO));
    expect(await services.nfce.ingestByDirectFetch(KEY)).toBeNull();
    // 2ª tentativa: portal entrega → UPSERT do documento + transação criada
    fetchMock.mockResolvedValueOnce(htmlResponse(PAGE));
    const res = await services.nfce.ingestByDirectFetch(KEY);
    expect(res!.created).toBe(true);
    const doc = await services.db.getFirstAsync<{ parse_status: string; transaction_id: string | null }>(
      'SELECT parse_status, transaction_id FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(doc?.parse_status).toBe('HEADER_ONLY');
    expect(doc?.transaction_id).toBe(res!.transactionId);
  });
});
