/**
 * v34 — IDENTIDADE NATIVA (Dalvik) como 1º degrau da leitura direta.
 *
 * Insight do usuário: com o Reqable ele capturou, no PRÓPRIO celular, um
 * pedido real de app nativo Android à SEFAZ-SP com User-Agent
 * "Dalvik/2.1.0 (Linux; U; Android 13; moto g52 Build/T2SRS33.72-22-4-11)".
 * Apps nativos são a classe de cliente do celular que o firewall F5
 * possivelmente aceita — o navegador embutido e o fetch com UA de navegador
 * já foram recusados na v32 (mesmo no WiFi residencial).
 *
 * Cobre:
 *  · a 1ª tentativa usa a identidade nativa com cabeçalhos MÍNIMOS (sem
 *    enfeite de navegador) e o canal 1 (QR assinado);
 *  · identidade nativa consegue a página no 1º canal → UM pedido só (grátis);
 *  · identidade nativa recusada no canal 1 → consegue no canal 2;
 *  · v36: recusada nos 2 canais → FIM (a reserva de navegador saiu — recusada
 *    em todos os testes reais; o papel de navegador é do motor do aparelho);
 *  · v36: com serviço configurado, o serviço vem ANTES do fetch direto.
 */

import { makeCtx } from './helpers';
import { SEFAZ_RETRY_DELAY } from '../services/NfceService';
import { SETTING_KEYS } from '../services/SettingsService';

const KEY = '35260514214169000187650010000012341234567890';

const PAGE = `<html><head><title>Consulta NFC-e - Secretaria da Fazenda</title></head><body>
  <div class="txtDados">Nome Empresarial: SENDAS DISTRIBUIDORA S/A</div>
  <div>CNPJ: 06.057.223/0508-61</div>
  <div>Valor Total: R$ 131,47</div>
</body></html>`;

const REJEICAO = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Your support ID is: 7</body></html>';

describe('v34 — identidade nativa (Dalvik) na leitura direta', () => {
  let fetchMock: jest.Mock;
  const htmlResponse = (html: string, status = 200) =>
    new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const uaOf = (call: unknown[]): string =>
    ((call[1] as { headers: Record<string, string> }).headers)['User-Agent'];

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    SEFAZ_RETRY_DELAY.minMs = 0;
    SEFAZ_RETRY_DELAY.maxMs = 0;
  });
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  test('a 1ª tentativa é a identidade nativa, com cabeçalhos mínimos de Java', async () => {
    const { services } = await makeCtx();
    fetchMock.mockResolvedValue(htmlResponse(REJEICAO));
    await services.nfce.ingestByDirectFetch(KEY);
    const [url, config] = fetchMock.mock.calls[0];
    // canal 1 = link do QR montado da chave (p=chave|3|1)
    expect(String(url)).toContain('ConsultaQRCode.aspx?p=');
    const headers = (config as { headers: Record<string, string> }).headers;
    expect(headers['User-Agent']).toContain('Dalvik/2.1.0 (Linux; U; Android 13; moto g52');
    // sem enfeite de navegador — Accept-Language/Cache-Control entregariam o disfarce
    expect(headers['Accept-Language']).toBeUndefined();
    expect(headers['Cache-Control']).toBeUndefined();
  });

  test('identidade nativa consegue a página no 1º canal → UM pedido só (de graça)', async () => {
    const { services } = await makeCtx();
    fetchMock.mockResolvedValueOnce(htmlResponse(PAGE));
    const res = await services.nfce.ingestByDirectFetch(KEY);
    expect(res).not.toBeNull();
    expect(res!.created).toBe(true);
    expect(res!.transactionId).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(uaOf(fetchMock.mock.calls[0])).toContain('Dalvik/');
  });

  test('identidade nativa recusada no canal 1 → consegue no canal 2 (sem ir ao navegador)', async () => {
    const { services } = await makeCtx();
    fetchMock
      .mockResolvedValueOnce(htmlResponse(REJEICAO))
      .mockResolvedValueOnce(htmlResponse(PAGE));
    const res = await services.nfce.ingestByDirectFetch(KEY);
    expect(res).not.toBeNull();
    expect(res!.created).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('ConsultaPublica.aspx?chaveAcesso=');
    expect(uaOf(fetchMock.mock.calls[1])).toContain('Dalvik/');
  });

  test('v36: recusada nos 2 canais Dalvik → FIM do fetch direto (reserva de navegador removida)', async () => {
    const { services } = await makeCtx();
    fetchMock.mockResolvedValue(htmlResponse(REJEICAO));
    const res = await services.nfce.ingestByDirectFetch(KEY);
    expect(res).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // 2 canais × 1 identidade
    const uas = fetchMock.mock.calls.map(uaOf);
    expect(uas[0]).toContain('Dalvik/');
    expect(uas[1]).toContain('Dalvik/');
    // nenhuma tentativa com UA de navegador — v36 tirou a reserva Mozilla
    expect(uas.every((ua) => ua.includes('Dalvik/'))).toBe(true);
  });

  test('v36: com serviço configurado, o serviço vem ANTES do fetch direto (o 1º pedido é dele)', async () => {
    const { services } = await makeCtx();
    await services.settings.set(SETTING_KEYS.nfceReaderProvider, 'scrapingbee');
    await services.settings.set(SETTING_KEYS.nfceReaderApiKey, 'chave-teste');
    // motor indisponível em teste → o serviço é o próximo degrau e entrega de primeira
    fetchMock.mockResolvedValueOnce(htmlResponse(PAGE));
    const res = await services.nfce.ingestByDirectFetch(KEY);
    expect(res).not.toBeNull();
    expect(res!.created).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('app.scrapingbee.com');
  });

  test('reprocessamento de itens também começa pela identidade nativa', async () => {
    const { services } = await makeCtx();
    // 1º ciclo: página com item chega pela identidade nativa (1º pedido)
    fetchMock.mockResolvedValueOnce(htmlResponse(PAGE));
    const first = await services.nfce.ingestByDirectFetch(KEY);
    expect(first?.created).toBe(true);
    // limpa o HTML para forçar o reprocessamento a buscar de novo
    await services.db.runAsync('UPDATE nfce_documents SET parse_status = ? WHERE access_key = ?', ['PARTIAL', KEY]);
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(htmlResponse(REJEICAO))
      .mockResolvedValueOnce(htmlResponse(PAGE));
    const out = await services.nfce.processItems(KEY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(uaOf(fetchMock.mock.calls[0])).toContain('Dalvik/');
    expect(out.items).toBeGreaterThanOrEqual(0);
  });
});
