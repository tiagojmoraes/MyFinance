/**
 * v33 — SERVIÇO DE LEITURA (o "ajudante na nuvem") da leitura de NFC-e.
 *
 * Contexto: a v32 testou no celular REAL do usuário (WiFi residencial limpo)
 * e os 2 canais da leitura direta foram recusados — o firewall F5 da SEFAZ-SP
 * julga o cliente, e o cliente do celular está marcado (logs 22:20–22:21).
 * A v33 adiciona o degrau "serviço de leitura": o app pede a página a um
 * serviço profissional (ScrapingBee/ScraperAPI — navegador completo + proxies,
 * a receita que passa), configurável em Ajustes.
 *
 * Cobre:
 *  · buildReaderEndpoint: endpoints corretos por provedor (ScrapingBee e
 *    ScraperAPI), com render/premium opcionais e URL da SEFAZ encodada;
 *  · isReaderConfigured: só conta com provedor escolhido + chave colada;
 *  · fetchNoteViaReader: cadeia adaptativa — simples falha (rejeição) →
 *    navegador (render JS) entrega a página; relato de tentativas no log;
 *  · ingestByDirectFetch com serviço configurado: leitura direta recusada →
 *    serviço entrega → lançamento criado (sem abrir navegador interno);
 *  · ingestByDirectFetch SEM serviço configurado: comportamento v32 (null);
 *  · processItems sem HTML e com serviço: usa o serviço para reprocessar itens;
 *  · persistência das configurações (app_settings).
 *
 * v34 (nota): a leitura direta passou a ter DUAS identidades (nativa Dalvik
 * primeiro, navegador de reserva) × 2 canais = 4 tentativas antes do serviço.
 */

import { makeCtx } from './helpers';
import { SEFAZ_RETRY_DELAY } from '../services/NfceService';
import { SETTING_KEYS } from '../services/SettingsService';
import {
  buildReaderEndpoint,
  fetchNoteViaReader,
  isReaderConfigured,
  readerProviderLabel,
  type NfceReaderConfig,
} from '../lib/nfceReader';

const KEY = '35260514214169000187650010000012341234567890';
const SEFAZ_URL = `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${KEY}%7C3%7C1`;

const PAGE = `<html><head><title>Consulta NFC-e - Secretaria da Fazenda</title></head><body>
  <div class="txtDados">Nome Empresarial: SENDAS DISTRIBUIDORA S/A</div>
  <div>CNPJ: 06.057.223/0508-61</div>
  <div>Valor Total: R$ 131,47</div>
</body></html>`;

const REJEICAO = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Your support ID is: 7</body></html>';

/** Página clássica COM item (tabResult/txtTit/Rqtd/RUN/RvlUnit) — p/ reprocessamento. */
const PAGE_COM_ITENS = `<html><head><title>Consulta NFC-e</title></head><body>
  <div class="txtDados">Nome Empresarial: SENDAS DISTRIBUIDORA S/A</div>
  <div>CNPJ: 06.057.223/0508-61</div>
  <div>Valor Total: R$ 131,47</div>
  <table id="tabResult"><tbody>
    <tr>
      <td><span class="txtTit">ARROZ TIPO 1 5KG</span><br>
      <span class="RCod">Código: 7896102500110</span></td>
      <td><span class="Rqtd"><strong>Qtde.:</strong> 1</span></td>
      <td><span class="RUN"><strong>UN:</strong> UN</span></td>
      <td><span class="RvlUnit"><strong>Vl. Unit.:</strong> 29,90</span></td>
      <td><span class="valor">29,90</span></td>
    </tr>
  </tbody></table>
</body></html>`;

const CFG: NfceReaderConfig = { provider: 'scrapingbee', apiKey: 'chave-teste' };

describe('v33 — buildReaderEndpoint (endpoints por provedor)', () => {
  test('ScrapingBee: pedido simples (1 crédito)', () => {
    const ep = buildReaderEndpoint('scrapingbee', 'abc123', SEFAZ_URL, { renderJs: false, premiumProxy: false });
    expect(ep).toBe(`https://app.scrapingbee.com/api/v1/?api_key=abc123&url=${encodeURIComponent(SEFAZ_URL)}&render_js=false`);
  });

  test('ScrapingBee: render JS e proxy premium quando pedidos', () => {
    const ep = buildReaderEndpoint('scrapingbee', 'abc123', SEFAZ_URL, { renderJs: true, premiumProxy: true });
    expect(ep).toContain('&render_js=true');
    expect(ep).toContain('&premium_proxy=true');
  });

  test('ScraperAPI: params render/premium próprios', () => {
    const ep = buildReaderEndpoint('scraperapi', 'xyz', SEFAZ_URL, { renderJs: true, premiumProxy: true });
    expect(ep).toContain('https://api.scraperapi.com/?api_key=xyz&url=');
    expect(ep).toContain('&render=true');
    expect(ep).toContain('&premium=true');
    expect(ep).not.toContain('render_js');
  });

  test('URL da SEFAZ vai ENCODADA (o serviço é quem visita)', () => {
    const ep = buildReaderEndpoint('scrapingbee', 'k', SEFAZ_URL, { renderJs: false, premiumProxy: false });
    expect(ep).not.toContain('nfce.fazenda.sp.gov.br/NFCe'); // crua não pode aparecer
    expect(ep).toContain(encodeURIComponent(SEFAZ_URL));
  });
});

describe('v33 — isReaderConfigured / rótulos', () => {
  test('sem provedor ou sem chave NÃO é configurado', () => {
    expect(isReaderConfigured(null)).toBe(false);
    expect(isReaderConfigured({ provider: 'none', apiKey: 'abc' })).toBe(false);
    expect(isReaderConfigured({ provider: 'scrapingbee', apiKey: '   ' })).toBe(false);
  });

  test('provedor + chave = configurado', () => {
    expect(isReaderConfigured(CFG)).toBe(true);
    expect(isReaderConfigured({ provider: 'scraperapi', apiKey: 'k' })).toBe(true);
  });

  test('rótulos amigáveis', () => {
    expect(readerProviderLabel('scrapingbee')).toBe('ScrapingBee');
    expect(readerProviderLabel('scraperapi')).toBe('ScraperAPI');
    expect(readerProviderLabel('none')).toBe('Nenhum');
  });
});

describe('v33 — fetchNoteViaReader (cadeia adaptativa)', () => {
  let fetchMock: jest.Mock;
  const htmlResponse = (html: string, status = 200) =>
    new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  test('simples recusada → navegador entrega a página (para no 2º degrau)', async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(REJEICAO)) // simples
      .mockResolvedValueOnce(htmlResponse(PAGE)); // navegador/render
    const out = await fetchNoteViaReader(CFG, SEFAZ_URL);
    expect(out.html).toContain('SENDAS DISTRIBUIDORA');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 1ª tentativa: render_js=false (barata); 2ª: render_js=true (navegador)
    expect(String(fetchMock.mock.calls[0][0])).toContain('render_js=false');
    expect(String(fetchMock.mock.calls[1][0])).toContain('render_js=true');
    // relato das tentativas (aparece no terminal)
    expect(out.attempts).toHaveLength(2);
    expect(out.attempts[0]).toContain('falhou');
    expect(out.attempts[1]).toContain('PÁGINA OK');
  });

  test('simples já entrega a página → UM degrau só (economia de créditos)', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse(PAGE));
    const out = await fetchNoteViaReader(CFG, SEFAZ_URL);
    expect(out.html).toContain('SENDAS DISTRIBUIDORA');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('todos os degraus falham → html null + relato completo', async () => {
    fetchMock.mockResolvedValue(htmlResponse(REJEICAO));
    const out = await fetchNoteViaReader(CFG, SEFAZ_URL);
    expect(out.html).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain('premium_proxy=true');
    expect(out.attempts).toHaveLength(3);
  });
});

describe('v33 — ingestByDirectFetch com o serviço na cadeia', () => {
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

  test('v36: serviço configurado vem ANTES do fetch — entrega e nem chama o portal direto', async () => {
    const { services } = await makeCtx();
    await services.settings.set(SETTING_KEYS.nfceReaderProvider, 'scrapingbee');
    await services.settings.set(SETTING_KEYS.nfceReaderApiKey, 'chave-teste');
    // motor indisponível em teste → o serviço é o próximo degrau: entrega de primeira
    fetchMock.mockResolvedValueOnce(htmlResponse(PAGE));
    const res = await services.nfce.ingestByDirectFetch(KEY);
    expect(res).not.toBeNull();
    expect(res!.created).toBe(true);
    expect(res!.transactionId).toBeTruthy();
    expect(res!.html).toContain('SENDAS DISTRIBUIDORA');
    // o 1º pedido da cadeia é o do serviço (nada de fetch direto antes)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('app.scrapingbee.com');
  });

  test('serviço NÃO configurado: o fetch direto tenta os 2 canais e devolve null (sem chamada ao serviço)', async () => {
    const { services } = await makeCtx();
    fetchMock.mockResolvedValue(htmlResponse(REJEICAO));
    const res = await services.nfce.ingestByDirectFetch(KEY);
    expect(res).toBeNull();
    // v36: só os 2 pedidos do fetch direto (2 canais × 1 identidade Dalvik) —
    // nenhuma chamada a app.scrapingbee.com
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('scrapingbee.com');
    }
  });

  test('v36: reprocessamento de itens usa o serviço ANTES do fetch direto', async () => {
    const { services } = await makeCtx();
    // 1º ciclo: leitura direta OK (página com item) → documento + transação criados
    fetchMock.mockResolvedValueOnce(htmlResponse(PAGE_COM_ITENS));
    const first = await services.nfce.ingestByDirectFetch(KEY);
    expect(first?.created).toBe(true);
    // Serviço configurado para o reprocessamento
    await services.settings.set(SETTING_KEYS.nfceReaderProvider, 'scraperapi');
    await services.settings.set(SETTING_KEYS.nfceReaderApiKey, 'chave-teste');
    fetchMock.mockClear();
    // v36: no reprocessamento o serviço vem antes do fetch → entrega de primeira
    fetchMock.mockResolvedValueOnce(htmlResponse(PAGE_COM_ITENS));
    const out = await services.nfce.processItems(KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('api.scraperapi.com');
    expect(out.items).toBe(1); // item extraído da página vinda do serviço
    const doc = await services.db.getFirstAsync<{ parse_status: string }>(
      'SELECT parse_status FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(doc?.parse_status).toBe('COMPLETE');
  });
});

describe('v33 — persistência das configurações do serviço', () => {
  test('provedor e chave sobrevivem a reload (app_settings)', async () => {
    const { services } = await makeCtx();
    await services.settings.set(SETTING_KEYS.nfceReaderProvider, 'scrapingbee');
    await services.settings.set(SETTING_KEYS.nfceReaderApiKey, 'minha-chave');
    expect(await services.settings.get(SETTING_KEYS.nfceReaderProvider)).toBe('scrapingbee');
    expect(await services.settings.get(SETTING_KEYS.nfceReaderApiKey)).toBe('minha-chave');
  });
});
