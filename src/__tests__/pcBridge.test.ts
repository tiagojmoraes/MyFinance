/**
 * Testes do pcBridge — v40.2: canal SERVIDOR DO PC.
 * Tudo 100% puro ou com fetch injetado — sem rede, sem RN, sem expo.
 */
import {
  candidatosBase,
  interpretarRespostaPc,
  acharServidorPc,
  consultarViaPc,
  resetarCacheServidorPc,
  PC_PROBE_TIMEOUT_MS,
  PC_CONSULTA_TIMEOUT_MS,
  PC_PORTA,
} from '../lib/pcBridge';

describe('pcBridge · candidatosBase (descoberta do servidor do PC)', () => {
  it('host do Metro no Wi-Fi → host + localhost', () => {
    expect(candidatosBase('192.168.0.12:8081')).toEqual([
      `http://192.168.0.12:${PC_PORTA}`,
      `http://localhost:${PC_PORTA}`,
    ]);
  });

  it('Metro por adb reverse (localhost) → só localhost', () => {
    expect(candidatosBase('localhost:8081')).toEqual([`http://localhost:${PC_PORTA}`]);
    expect(candidatosBase('127.0.0.1:8081')).toEqual([`http://localhost:${PC_PORTA}`]);
  });

  it('sem hostUri (produção/teste) → só localhost', () => {
    expect(candidatosBase(null)).toEqual([`http://localhost:${PC_PORTA}`]);
    expect(candidatosBase(undefined)).toEqual([`http://localhost:${PC_PORTA}`]);
    expect(candidatosBase('')).toEqual([`http://localhost:${PC_PORTA}`]);
  });

  it('hostUri maluco não quebra', () => {
    expect(candidatosBase('meupc.local:19000')[0]).toBe(`http://meupc.local:${PC_PORTA}`);
  });
});

describe('pcBridge · interpretarRespostaPc (protocolo do servidor)', () => {
  const HTML_GRANDE = 'x'.repeat(100);

  it('200 ok:true com html real → tipo ok com bytes/estratégia/tempo', () => {
    const r = interpretarRespostaPc(200, { ok: true, html: HTML_GRANDE, bytes: 123, estrategia: 'navegador', elapsedMs: 4321 });
    expect(r).toEqual({ tipo: 'ok', html: HTML_GRANDE, bytes: 123, estrategia: 'navegador', ms: 4321 });
  });

  it('200 ok:true sem bytes/estratégia → defaults coerentes', () => {
    const r = interpretarRespostaPc(200, { ok: true, html: HTML_GRANDE });
    expect(r.tipo).toBe('ok');
    if (r.tipo === 'ok') {
      expect(r.bytes).toBe(100);
      expect(r.estrategia).toBe('fetch');
      expect(r.ms).toBe(0);
    }
  });

  it('html curto (lixo/interstitial) NÃO é "ok"', () => {
    expect(interpretarRespostaPc(200, { ok: true, html: 'curto' }).tipo).toBe('indisponivel');
    expect(interpretarRespostaPc(200, { ok: true }).tipo).toBe('indisponivel');
  });

  it('403 bloqueado:true → tipo bloqueado com supportId', () => {
    const r = interpretarRespostaPc(403, { ok: false, bloqueado: true, html: 'The requested URL was rejected', supportId: '12345' });
    expect(r).toEqual({ tipo: 'bloqueado', html: 'The requested URL was rejected', supportId: '12345' });
  });

  it('403 bloqueado SEM html → bloqueado sem html (app usa a falsa)', () => {
    const r = interpretarRespostaPc(403, { ok: false, bloqueado: true });
    expect(r).toEqual({ tipo: 'bloqueado', html: undefined, supportId: null });
  });

  it('403 desafio:true → tipo desafio', () => {
    const r = interpretarRespostaPc(403, { ok: false, desafio: true, html: '<!--TSPD-->' });
    expect(r).toEqual({ tipo: 'desafio', html: '<!--TSPD-->' });
  });

  it('429 com gate → tipo gate com segundos', () => {
    expect(interpretarRespostaPc(429, { ok: false, gate: 60, motivo: 'cooldown' })).toEqual({ tipo: 'gate', segundos: 60 });
  });

  it('gate 0 / corpo nulo / servidor quebrado → indisponivel', () => {
    expect(interpretarRespostaPc(429, { ok: false, gate: 0 }).tipo).toBe('indisponivel');
    expect(interpretarRespostaPc(500, { erro: 'interno' }).tipo).toBe('indisponivel');
    expect(interpretarRespostaPc(200, null).tipo).toBe('indisponivel');
    expect(interpretarRespostaPc(200, 'texto não-JSON').tipo).toBe('indisponivel');
  });
});

describe('pcBridge · acharServidorPc (descoberta com fetch injetado)', () => {
  beforeEach(() => resetarCacheServidorPc());

  /** Stub que responde /health como o servidor-nfce.js de verdade. */
  const healthOk = (urlEsperada: string): typeof fetch =>
    ((url: string) => {
      expect(url).toBe(urlEsperada);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, servidor: 'nfce-pc' }) } as Response);
    }) as unknown as typeof fetch;

  it('acha o servidor em localhost (fora do Expo o hostUri é null) e devolve a base', async () => {
    await expect(acharServidorPc(healthOk(`http://localhost:${PC_PORTA}/health`))).resolves.toBe(`http://localhost:${PC_PORTA}`);
  });

  it('CACHE: segunda chamada não re-probe (1 só /health)', async () => {
    let chamadas = 0;
    const f = ((url: string) => {
      chamadas += 1;
      expect(url).toBe(`http://localhost:${PC_PORTA}/health`);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ servidor: 'nfce-pc' }) } as Response);
    }) as unknown as typeof fetch;
    await acharServidorPc(f);
    await acharServidorPc(f);
    expect(chamadas).toBe(1); // 2ª chamada veio do cache
  });

  it('servidor ausente → null (e cache negativo não re-probe)', async () => {
    const f = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    await expect(acharServidorPc(f)).resolves.toBeNull();
    let chamadas = 0;
    const f2 = (() => {
      chamadas += 1;
      return Promise.reject(new Error('x'));
    }) as unknown as typeof fetch;
    await acharServidorPc(f2);
    expect(chamadas).toBe(0); // cache negativo
  });

  it('serviço errado na porta 3000 (sem identidade "nfce-pc") → null', async () => {
    const f = (() => Promise.resolve({ ok: true, json: () => Promise.resolve({ servidor: 'outro-servico' }) } as Response)) as unknown as typeof fetch;
    await expect(acharServidorPc(f)).resolves.toBeNull();
  });

  it('constantes de tempo expostas para documentar o contrato', () => {
    expect(PC_PROBE_TIMEOUT_MS).toBe(2_000);
    expect(PC_CONSULTA_TIMEOUT_MS).toBe(25_000);
  });
});

describe('pcBridge · consultarViaPc (com fetch injetado)', () => {
  beforeEach(() => resetarCacheServidorPc());

  it('manda POST JSON {url} e devolve ok', async () => {
    let captura: { url: string; init?: RequestInit } | null = null;
    const f = ((url: string, init?: RequestInit) => {
      captura = { url, init };
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ ok: true, html: 'h'.repeat(100), bytes: 100, estrategia: 'fetch', elapsedMs: 900 })),
      } as Response);
    }) as unknown as typeof fetch;
    const r = await consultarViaPc(`http://localhost:${PC_PORTA}`, 'https://www.nfce.fazenda.sp.gov.br/x', f);
    expect(captura!.url).toBe(`http://localhost:${PC_PORTA}/consultar`);
    expect((captura!.init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((captura!.init as RequestInit).body))).toEqual({ url: 'https://www.nfce.fazenda.sp.gov.br/x' });
    expect(r?.tipo).toBe('ok');
  });

  it('resposta bloqueado do servidor vira tipo bloqueado', async () => {
    const f = (() => Promise.resolve({
      status: 403,
      text: () => Promise.resolve(JSON.stringify({ ok: false, bloqueado: true, supportId: '777' })),
    } as Response)) as unknown as typeof fetch;
    const r = await consultarViaPc(`http://localhost:${PC_PORTA}`, 'https://www.nfce.fazenda.sp.gov.br/x', f);
    expect(r).toEqual({ tipo: 'bloqueado', html: undefined, supportId: '777' });
  });

  it('PC sumiu no meio (rede estourou) → null, NUNCA lança', async () => {
    const f = (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;
    await expect(consultarViaPc(`http://localhost:${PC_PORTA}`, 'https://x', f)).resolves.toBeNull();
  });

  it('resposta não-JSON do servidor → indisponivel (não quebra o app)', async () => {
    const f = (() => Promise.resolve({ status: 200, text: () => Promise.resolve('<html>lixo</html>') } as Response)) as unknown as typeof fetch;
    await expect(consultarViaPc(`http://localhost:${PC_PORTA}`, 'https://x', f)).resolves.toEqual({ tipo: 'indisponivel' });
  });
});
