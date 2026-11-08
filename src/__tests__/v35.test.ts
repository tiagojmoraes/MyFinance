/**
 * v35 — MOTOR DO APARELHO como 1º degrau da leitura NFC-e.
 *
 * "Colocar o mesmo processo da aplicação que funciona na função NFC-e":
 * a página da nota agora é buscada PRIMEIRO pela WebView oculta do próprio
 * aparelho (engine, TLS, cookies e JavaScript reais — a MESMA identidade
 * "; wv" + Chrome real que o JSON do usuário provou no app que funciona),
 * e depois pelos degraus reserva (serviço de leitura → fetch Dalvik).
 *
 * Cobre:
 *  · decideCaptureAction (decisão pura sobre o HTML capturado);
 *  · ponte sem motor montado → degrau pulado (null rápido);
 *  · motor entregando a nota → transação criada e ZERO fetch direto;
 *  · motor recebendo rejeição → tenta o 2º canal → cai para o fetch Dalvik;
 *  · motor devolvendo null (tempo/erro) e página desconhecida → cadeia segue;
 *  · nota já registrada → motor NEM é chamado (idempotência vale antes);
 *  · reprocessamento de itens (processItems) também começa pelo motor;
 *  · contratos: timeout do motor e limites de espera de desafio.
 */

import { makeCtx } from './helpers';
import {
  nfceWebEngine,
  WEBENGINE_TIMEOUT_MS,
  CHALLENGE_MAX_WAITS,
  UNKNOWN_MAX_WAITS,
  decideCaptureAction,
  isGenuineWebViewUa,
  type NfceWebEngineDriver,
} from '../services/NfceWebEngine';
import { SEFAZ_RETRY_DELAY } from '../services/NfceService';

const KEY = '35260514214169000187650010000012341234567890';

const PAGE = `<html><head><title>Consulta NFC-e - Secretaria da Fazenda</title></head><body>
  <div class="txtDados">Nome Empresarial: SENDAS DISTRIBUIDORA S/A</div>
  <div>CNPJ: 06.057.223/0508-61</div>
  <div>Valor Total: R$ 131,47</div>
</body></html>`;

const PAGE_COM_ITENS = `<html><head><title>Consulta NFC-e</title></head><body>
  <div class="txtDados">Nome Empresarial: MERCADO EXEMPLO LTDA</div>
  <div>Valor Total: R$ 30,95</div>
  <table>
  <tr><td><span class="txtTit">LEITE INTEGRAL 1L</span><span class="txtCod">Código do produto: 7894900011517</span>
  <span class="Rqtd">Qtde total de itens: 2</span><span class="RUN">Unidade comercial: UN</span>
  <span class="valor">Valor total do item: R$ 15,98</span></td></tr>
  </table>
</body></html>`;

const REJEICAO = '<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Your support ID is: 7</body></html>';

const DESAFIO = '<html><head><title>302 Found</title></head><body><script type="text/javascript" src="/TSPD/?type=14"></script><a href="javascript:...">APM_DO_NOT_TOUCH</a></body></html>';

const DESCONHECIDA = '<html><head><title>Aviso</title></head><body>Sistema temporariamente indisponível.</body></html>';

/** Driver falso que registra cada chamada da ponte. */
function makeDriver(fn: (url: string, timeoutMs: number) => Promise<{ html: string; url: string } | null>) {
  const driver: NfceWebEngineDriver & { calls: { url: string; timeoutMs: number }[] } = {
    calls: [],
    read(url: string, timeoutMs: number) {
      driver.calls.push({ url, timeoutMs });
      return fn(url, timeoutMs);
    },
  };
  return driver;
}

describe('v36 — isGenuineWebViewUa (a identidade da captura que funciona)', () => {
  test('UA real do app que funciona (WebView genuína, "; wv" + Chrome) → true', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 13; moto g52 Build/T2SRS33.72-22-4-11; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.47 Mobile Safari/537.36';
    expect(isGenuineWebViewUa(ua)).toBe(true);
  });

  test('UA Dalvik (app nativo sem WebView) → false', () => {
    expect(
      isGenuineWebViewUa('Dalvik/2.1.0 (Linux; U; Android 13; moto g52 Build/T2SRS33.72-22-4-11)')
    ).toBe(false);
  });

  test('UA de Chrome fingido da v23 (sem "; wv") → false', () => {
    expect(
      isGenuineWebViewUa(
        'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
      )
    ).toBe(false);
  });
});

describe('v35 — decideCaptureAction (decisão pura da captura)', () => {
  test('página da nota → deliver (mesmo com marcador de desafio no meio)', () => {
    expect(decideCaptureAction(PAGE)).toEqual({ action: 'deliver' });
    const mista = `<html><body>Consulta NFC-e TSPD APM_DO_NOT_TOUCH <div>Nome Empresarial: X</div><div>Valor Total: R$ 1,00</div></body></html>`;
    expect(decideCaptureAction(mista)).toEqual({ action: 'deliver' });
  });

  test('rejeição dura do firewall → hand-over (não adianta esperar)', () => {
    expect(decideCaptureAction(REJEICAO)).toEqual({ action: 'hand-over', kind: 'rejection' });
  });

  test('desafio do F5 (TSPD/APM_DO_NOT_TOUCH) → wait de desafio', () => {
    const d = decideCaptureAction(DESAFIO);
    expect(d).toEqual({ action: 'wait', kind: 'challenge', delayMs: 2500 });
  });

  test('página desconhecida → wait curto', () => {
    expect(decideCaptureAction(DESCONHECIDA)).toEqual({ action: 'wait', kind: 'unknown', delayMs: 1500 });
  });

  test('contratos do motor (timeout e limites de espera)', () => {
    expect(WEBENGINE_TIMEOUT_MS).toBe(20_000);
    expect(CHALLENGE_MAX_WAITS).toBe(4);
    expect(UNKNOWN_MAX_WAITS).toBe(2);
  });
});

describe('v35 — motor do aparelho na cadeia de leitura', () => {
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

  test('sem motor montado: degrau pulado (ponte devolve null, sem erro)', async () => {
    expect(nfceWebEngine.hasDriver()).toBe(false);
    await expect(nfceWebEngine.read('https://exemplo', 1000)).resolves.toBeNull();
    expect(nfceWebEngine.hasDriver()).toBe(false);
  });

  test('motor entregando a nota no 1º canal → transação criada e ZERO fetch direto', async () => {
    const { services } = await makeCtx();
    const driver = makeDriver(async (url) => ({ html: PAGE, url }));
    nfceWebEngine.attach(driver);
    try {
      const res = await services.nfce.ingestByDirectFetch(KEY);
      expect(res).not.toBeNull();
      expect(res!.created).toBe(true);
      expect(res!.transactionId).toBeTruthy();
      // o motor recebeu o trabalho com o canal 1 (QR) e o timeout oficial
      expect(driver.calls).toHaveLength(1);
      expect(driver.calls[0].url).toContain('ConsultaQRCode.aspx?p=');
      expect(driver.calls[0].timeoutMs).toBe(WEBENGINE_TIMEOUT_MS);
      // fetch NEM existe no caminho: o motor resolveu sozinho
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      nfceWebEngine.detach(driver);
    }
  });

  test('motor com rejeição nos 2 canais → cai para o fetch com identidade Dalvik', async () => {
    const { services } = await makeCtx();
    const driver = makeDriver(async (url) => ({ html: REJEICAO, url }));
    nfceWebEngine.attach(driver);
    try {
      fetchMock.mockResolvedValue(htmlResponse(PAGE));
      const res = await services.nfce.ingestByDirectFetch(KEY);
      expect(res).not.toBeNull();
      expect(res!.created).toBe(true);
      // motor esgotou os 2 canais antes de passar a vez ao fetch
      expect(driver.calls).toHaveLength(2);
      expect(driver.calls[0].url).toContain('ConsultaQRCode.aspx?p=');
      expect(driver.calls[1].url).toContain('ConsultaPublica.aspx?chaveAcesso=');
      // 1º fetch = identidade nativa Dalvik (degrau v34 preservado como reserva)
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
      expect(headers['User-Agent']).toContain('Dalvik/');
    } finally {
      nfceWebEngine.detach(driver);
    }
  });

  test('motor devolvendo null (tempo/erro) nos 2 canais → cadeia segue pelo fetch', async () => {
    const { services } = await makeCtx();
    const driver = makeDriver(async () => null);
    nfceWebEngine.attach(driver);
    try {
      fetchMock.mockResolvedValue(htmlResponse(PAGE));
      const res = await services.nfce.ingestByDirectFetch(KEY);
      expect(res).not.toBeNull();
      expect(res!.created).toBe(true);
      expect(driver.calls).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      nfceWebEngine.detach(driver);
    }
  });

  test('motor devolvendo página desconhecida → não é aceita, cadeia segue', async () => {
    const { services } = await makeCtx();
    const driver = makeDriver(async (url) => ({ html: DESCONHECIDA, url }));
    nfceWebEngine.attach(driver);
    try {
      fetchMock.mockResolvedValue(htmlResponse(PAGE));
      const res = await services.nfce.ingestByDirectFetch(KEY);
      expect(res).not.toBeNull();
      expect(res!.created).toBe(true);
      expect(driver.calls).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      nfceWebEngine.detach(driver);
    }
  });

  test('nota já registrada com transação real → motor NEM é consultado', async () => {
    const { services } = await makeCtx();
    const driver = makeDriver(async (url) => ({ html: PAGE, url }));
    nfceWebEngine.attach(driver);
    try {
      const first = await services.nfce.ingestByDirectFetch(KEY);
      expect(first!.created).toBe(true);
      const id = first!.transactionId;
      expect(driver.calls).toHaveLength(1);
      const second = await services.nfce.ingestByDirectFetch(KEY);
      expect(second!.created).toBe(false);
      expect(second!.transactionId).toBe(id);
      // nenhuma chamada nova ao motor e nenhum fetch: idempotência vale antes
      expect(driver.calls).toHaveLength(1);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      nfceWebEngine.detach(driver);
    }
  });

  test('reprocessamento de itens (processItems) também começa pelo motor', async () => {
    const { db, services } = await makeCtx();
    const qrUrl = `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${KEY}%7C3%7C1`;
    await db.runAsync(
      "INSERT INTO nfce_documents (access_key, source_url, parse_status) VALUES (?, ?, 'PENDING')",
      [KEY, qrUrl]
    );
    const driver = makeDriver(async (url) => ({ html: PAGE_COM_ITENS, url }));
    nfceWebEngine.attach(driver);
    try {
      const out = await services.nfce.processItems(KEY);
      expect(driver.calls).toHaveLength(1);
      expect(driver.calls[0].url).toBe(qrUrl);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(out.items).toBeGreaterThanOrEqual(1);
      const doc = await db.getFirstAsync<{ parse_status: string }>(
        'SELECT parse_status FROM nfce_documents WHERE access_key = ?',
        [KEY]
      );
      expect(['COMPLETE', 'PARTIAL']).toContain(doc?.parse_status);
    } finally {
      nfceWebEngine.detach(driver);
    }
  });

  test('driver que lança exceção NUNCA derruba a cadeia (vira null)', async () => {
    const boom: NfceWebEngineDriver = {
      read: async () => {
        throw new Error('engine explodiu');
      },
    };
    nfceWebEngine.attach(boom);
    try {
      await expect(nfceWebEngine.read('https://exemplo', 1000)).resolves.toBeNull();
    } finally {
      nfceWebEngine.detach(boom);
    }
  });
});
