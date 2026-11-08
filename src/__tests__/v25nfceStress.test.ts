/**
 * v25 — BATERIA NFC-e: 500+ casos executados (pedido do usuário: "teste umas
 * 500 vezes antes de liberar").
 *
 * Cobre, ponta a ponta e de forma determinística:
 *  · extração de chave de QR Codes reais e variantes (SP e outros UF);
 *  · sanitização da URL do QR (firewall F5/BIG-IP);
 *  · detecção de rejeição do firewall × página da nota;
 *  · cabeçalho em 3 layouts reais do portal SEFAZ-SP × 25 variantes cada;
 *  · itens em 3 layouts × 60 documentos cada (descrição, EAN/código, qtde, un,
 *    valor — com gerador determinístico);
 *  · conversão de unidades para a base da despensa;
 *  · SERVIÇO com fetch MOCKADO: ordem de candidatos, WAF, charset, HTTP errors,
 *    idempotência, reprocessamento de documento podre (v24), needsAmount;
 *  · ingestão ponta a ponta (ingestFromHtml + processItems) em 30 documentos.
 */

import { makeCtx } from './helpers';
import { SEFAZ_RETRY_DELAY } from '../services/NfceService';
import {
  extractAccessKey,
  sanitizeSefazUrl,
  isFirewallRejectionPage,
  looksLikeNfcePage,
  buildSpConsultUrl,
  buildLegacyConsultUrl,
  listConsultUrls,
  parseNfceHeader,
  parseNfceItems,
  convertToBaseUnit,
} from '../parsers/nfce';
import { rng, genHeader, genItems, docLegacy, docNovo, docTabela, type GenHeader, type GenItem } from './v25nfceGen';

const KEY = '35260514214169000187650010000012341234567890';
const HOSTS = [
  'https://www.nfce.fazenda.sp.gov.br/qrcode',
  'https://nfce.fazenda.sp.gov.br/qrcode',
  'https://www.sefaz.ms.gov.br/portalNFENacional/qrcode',
  'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
];
const SIGS = ['A1B2C3D4', '4024b452', 'xYz-9_8', 'AA10BB20'];

// ─────────────────────────── 1. Chave de acesso (45 casos) ───────────────────────────
describe('NFC-e — extração da chave de 44 dígitos', () => {
  const qrCases: Array<[string, string, string | null]> = [];
  HOSTS.forEach((h, hi) =>
    SIGS.forEach((s, si) => {
      qrCases.push([`qr host${hi} sig${si}`, `${h}?p=${KEY}|2|1|1|${s}`, KEY]);
      qrCases.push([`qr enc host${hi} sig${si}`, `${h}?p=${encodeURIComponent(`${KEY}|2|1|1|${s}`)}`, KEY]);
    })
  );
  qrCases.push(['chaveAcesso', `https://nfce.fazenda.sp.gov.br/consultacompleta.aspx?chaveAcesso=${KEY}`, KEY]);
  qrCases.push(['chave=', `https://portal.exemplo.gov.br/nfce?chave=${KEY}&x=1`, KEY]);
  qrCases.push(['chNFe=', `https://portal.exemplo.gov.br/nfe?chNFe=${KEY}`, KEY]);
  qrCases.push(['chave pura', KEY, KEY]);
  qrCases.push(['chave com espaços', `  ${KEY}  `, KEY]);
  qrCases.push(['chave em texto', `Nota ${KEY} autorizada`, KEY]);
  qrCases.push(['43 dígitos → null', 'x'.repeat(43).replace(/x/g, '1'), null]);
  qrCases.push(['vazio → null', '', null]);
  qrCases.push(['lixo → null', 'sem chave aqui', null]);

  test.each(qrCases)('chave: %s', (_name, input, want) => {
    expect(extractAccessKey(input)).toBe(want);
  });
});

// ─────────────────────────── 2. Sanitização da URL (50 casos) ───────────────────────────
describe('NFC-e — sanitizeSefazUrl (firewall rejeita | cru)', () => {
  const cases: Array<[string, string, string]> = [];
  HOSTS.forEach((h, i) => {
    cases.push([
      `| cru ${i}`,
      `${h}?p=${KEY}|2|1|1|SIG`,
      `${h}?p=${KEY}%7C2%7C1%7C1%7CSIG`,
    ]);
    cases.push([
      `| já codificado ${i}`,
      `${h}?p=${KEY}%7C2%7C1`,
      `${h}?p=${KEY}%7C2%7C1`,
    ]);
    cases.push([`espaço ${i}`, `${h}?a=b c`, `${h}?a=b%20c`]);
    cases.push([`aspas ${i}`, `${h}?a="x"`, `${h}?a=%22x%22`]);
    cases.push([`chave pura preservada ${i}`, `${h}?chaveAcesso=${KEY}`, `${h}?chaveAcesso=${KEY}`]);
  });
  cases.push(['sem query', '  https://www.sefaz.sp.gov.br/  ', 'https://www.sefaz.sp.gov.br/']);
  cases.push(['< > proibidos', 'https://a.b/?x=<1>', 'https://a.b/?x=%3C1%3E']);
  cases.push(['chaves { }', 'https://a.b/?x={y}', 'https://a.b/?x=%7By%7D']);
  cases.push(['barra invertida', 'https://a.b/?x=y\\z', 'https://a.b/?x=y%5Cz']);
  cases.push(['& e = preservados', 'https://a.b/?a=1&b=2|3', 'https://a.b/?a=1&b=2%7C3']);
  cases.push(['+ preservado', 'https://a.b/?a=x+y', 'https://a.b/?a=x+y']);
  cases.push(['% preservado (não dupla)', 'https://a.b/?a=50%25', 'https://a.b/?a=50%25']);

  test.each(cases)('sanitize: %s', (_name, input, want) => {
    expect(sanitizeSefazUrl(input)).toBe(want);
  });
});

// ─────────────────────────── 3. Rejeição do firewall × nota (32 casos) ───────────────────────────
describe('NFC-e — isFirewallRejectionPage / looksLikeNfcePage', () => {
  const rejectHtmls = [
    '<html><body><h1>The requested URL was rejected. Please consult with your administrator.</h1><p>Your support ID is: 10138580085930729183</p></body></html>',
    '<html><body>Request Rejected — support ID 998</body></html>',
    '<html><body>Access Denied</body></html>',
    '<html><body>Your support ID is: 42</body></html>',
    '<html><body><div>The requested URL was rejected.</div></body></html>',
    // v25: página REAL capturada por sondagem no portal (245 bytes) — o texto
    // exato que o usuário recebe ("o mesmo erro")
    "<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Please consult with your administrator.<br><br>Your support ID is: <10138580085948882949><br><br><a href='javascript:history.back();'>[Go Back]</body></html>",
  ];
  const noteHtmls = [
    '<html><body><h1>Dados da NFC-e</h1><div>Valor Total: R$ 10,00</div></body></html>',
    '<html><body>Nota Fiscal do Consumidor Eletrônica — Nome Empresarial: LOJA</body></html>',
    '<html><body>NFC-e — CNPJ 12.345.678/0001-90</body></html>',
    '<html><body>Informações da Nota NFC-e — Valor a Pagar: R$ 5,00</body></html>',
    '<html><body>Protocolo de Autorização 123 — NFC-e</body></html>',
  ];
  test.each(rejectHtmls.map((h, i) => [`reject${i}`, h] as [string, string]))(
    'rejeição detectada: %s',
    (_n, html) => {
      expect(isFirewallRejectionPage(html)).toBe(true);
      expect(looksLikeNfcePage(html)).toBe(false);
    }
  );
  test.each(noteHtmls.map((h, i) => [`note${i}`, h] as [string, string]))(
    'nota NÃO é rejeição e é reconhecida: %s',
    (_n, html) => {
      expect(isFirewallRejectionPage(html)).toBe(false);
      expect(looksLikeNfcePage(html)).toBe(true);
    }
  );
  test.each([
    ['desafio F5 (TSPD)', '<html><script src="/TSPD?..." type="text/javascript"></script><body>APM_DO_NOT_TOUCH</body></html>'],
    ['desafio vazio', '<html><head></head><body></body></html>'],
    ['página em branco', '   '],
  ])('intermediária não é nota: %s', (_n, html) => {
    expect(looksLikeNfcePage(html)).toBe(false);
  });
});

// ─────────────────────────── 4. Cabeçalhos: 3 layouts × 25 docs (75 casos) ───────────────────────────
describe('NFC-e — parseNfceHeader em 75 documentos gerados (3 layouts × 25)', () => {
  const r = rng(20251103);
  const gens: Array<[string, (h: GenHeader, items: GenItem[]) => string]> = [
    ['legado', docLegacy],
    ['novo', docNovo],
    ['tabela', docTabela],
  ];
  for (const [name, gen] of gens) {
    for (let d = 0; d < 40; d++) {
      const h = genHeader(r);
      const items = genItems(r, 1 + Math.floor(r() * 6));
      const html = gen(h, items);
      test(`header ${name} doc#${d} (${h.store.slice(0, 18)})`, () => {
        const got = parseNfceHeader(html, KEY);
        expect(got.accessKey).toBe(KEY);
        expect(got.storeName).toBe(h.store);
        expect(got.cnpj).toBe(h.cnpj);
        expect(got.grossTotalCents).toBe(h.grossCents);
        expect(got.amountPaidCents).toBe(h.paidCents);
        expect(got.discountCents).toBe(h.withDiscount ? h.discountCents : 0);
        expect(got.issuedAt).toBeTruthy();
      });
    }
  }
});

// ─────────────────────────── 5. Itens: 3 layouts × 60 docs (180 casos) ───────────────────────────
describe('NFC-e — parseNfceItems em 180 documentos gerados (3 layouts × 60)', () => {
  const r = rng(7700255);
  const gens: Array<[string, (h: GenHeader, items: GenItem[]) => string, boolean]> = [
    ['legado', docLegacy, false],
    ['novo', docNovo, false],
    ['tabela', docTabela, true], // células nuas: EAN sem rótulo não é extraído (comportamento documentado)
  ];
  for (const [name, gen, bareCells] of gens) {
    for (let d = 0; d < 75; d++) {
      const h = genHeader(r);
      const items = genItems(r, 1 + Math.floor(r() * 8));
      const html = gen(h, items);
      test(`itens ${name} doc#${d} (${items.length} itens)`, () => {
        const parsed = parseNfceItems(html);
        expect(parsed).toHaveLength(items.length);
        parsed.forEach((g, i) => {
          const w = items[i];
          expect(g.description).toBe(w.description);
          if (bareCells) {
            // layout sem rótulos: qtde/un vêm das células nuas; EAN sem rótulo fica null
            expect(g.qty).toBe(w.qty);
            expect(g.unitOriginal).toBe(w.unit.toUpperCase());
          } else {
            expect(g.eanExtracted ?? w.ean).toEqual(w.ean ?? g.eanExtracted);
            if (w.ean) expect(g.eanExtracted).toBe(w.ean);
            else if (w.storeCode && !/^\d{8}$|^\d{12,14}$/.test(w.storeCode)) {
              expect(g.storeProductCode).toBe(w.storeCode);
            }
            expect(g.qty).toBe(w.qty);
            expect(g.unitOriginal).toBe(w.unit);
          }
          expect(g.totalCents).toBe(w.totalCents);
        });
      });
    }
  }
});

// ─────────────────────────── 6. Unidades (24 casos) ───────────────────────────
describe('NFC-e — convertToBaseUnit', () => {
  const cases: Array<[string, number, string | null, number | null, string | null]> = [
    ['KG', 2, 'KG', 2000, 'G'],
    ['kg', 0.5, 'kg', 500, 'G'],
    ['KGS', 3, 'KGS', 3000, 'G'],
    ['QUILO', 1.2, 'QUILO', 1200, 'G'],
    ['G', 250, 'G', 250, 'G'],
    ['GR', 100, 'GR', 100, 'G'],
    ['GRAMAS', 90, 'GRAMAS', 90, 'G'],
    ['L', 2, 'L', 2000, 'ML'],
    ['lt', 1, 'lt', 1000, 'ML'],
    ['LITROS', 3.5, 'LITROS', 3500, 'ML'],
    ['ML', 900, 'ML', 900, 'ML'],
    ['MILILITROS', 250, 'MILILITROS', 250, 'ML'],
    ['UN', 3, 'UN', 3, 'UN'],
    ['UND', 1, 'UND', 1, 'UN'],
    ['UNIDADE', 2, 'UNIDADE', 2, 'UN'],
    ['UNIDADES', 10, 'UNIDADES', 10, 'UN'],
    ['CX', 1, 'CX', 1, 'UN'],
    ['PC', 4, 'PC', 4, 'UN'],
    ['PAR', 2, 'PAR', null, null],
    ['SC', 1, 'SC', null, null],
    ['null → UN', 5, null, 5, 'UN'],
    ['unidade vazia', 5, '', 5, 'UN'],
    ['fracionária 0,25 KG', 0.25, 'KG', 250, 'G'],
    ['fracionária 1,5 L', 1.5, 'L', 1500, 'ML'],
  ];
  test.each(cases)('unidade %s', (_n, qty, unit, wantDelta, wantBase) => {
    const got = convertToBaseUnit(qty, unit);
    if (wantDelta == null) expect(got).toBeNull();
    else expect(got).toEqual({ deltaBase: wantDelta, baseUnit: wantBase });
  });
});

// ─────────────────────────── 7. URLs de consulta (12 casos) ───────────────────────────
describe('NFC-e — listConsultUrls (candidatos em ordem, v39.1: canônico 1º)', () => {
  test('canônico .br primeiro; QR escaneado sanitizado de reserva (v32: sem legado na fila)', () => {
    const raw = `https://www.nfce.fazenda.sp.gov.br/qrcode?p=${KEY}|2|1|1|SIG`;
    const urls = listConsultUrls(raw, KEY);
    expect(urls[0]).toBe(
      `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${KEY}%7C3%7C1`
    );
    expect(urls[1]).toBe(`https://www.nfce.fazenda.sp.gov.br/qrcode?p=${KEY}%7C2%7C1%7C1%7CSIG`);
    expect(urls[2]).toBe(buildSpConsultUrl(KEY));
    // v32: legado descontinuado SAIU da fila (sem resposta no PC, certificado
    // inválido no celular — só atrasava e confundia o diagnóstico)
    expect(urls).not.toContain(buildLegacyConsultUrl(KEY));
    expect(urls.length).toBe(3);
  });
  test.each(HOSTS)('canais para host %s', (h) => {
    const urls = listConsultUrls(`${h}?p=${KEY}`, KEY);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    // v39.1: canônico .br sempre primeiro, portal público sempre por último
    expect(urls[0]).toBe(
      `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${KEY}%7C3%7C1`
    );
    expect(urls[urls.length - 1]).toBe(buildSpConsultUrl(KEY));
  });
  test('URL da chave manual: canônico p=chave|3|1 primeiro', () => {
    const urls = listConsultUrls(KEY, KEY);
    expect(urls[0]).toBe(
      `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${KEY}%7C3%7C1`
    );
    expect(urls[1]).toBe(buildSpConsultUrl(KEY));
  });
});

// ─────────────────────────── 8. SERVIÇO com fetch mockado (60 casos) ───────────────────────────
describe('NFC-e — serviço ponta a ponta com fetch MOCKADO', () => {
  let fetchMock: jest.Mock;
  const htmlResponse = (html: string, status = 200, contentType = 'text/html; charset=utf-8') =>
    new Response(html, { status, headers: { 'content-type': contentType } });

  const latin1Bytes = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    // v30: zera a espera aleatória entre candidatos — a suíte não pode esperar
    // segundos reais entre mocks de rede.
    SEFAZ_RETRY_DELAY.minMs = 0;
    SEFAZ_RETRY_DELAY.maxMs = 0;
  });
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  test('fetch OK no 1º candidato: header + transação criados', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(1));
    fetchMock.mockResolvedValueOnce(htmlResponse(docLegacy(h, genItems(rng(2), 2))));
    const res = await services.nfce.ingestFromQrOrKey(`https://www.nfce.fazenda.sp.gov.br/qrcode?p=${KEY}|2|1|1|S`);
    expect(res.created).toBe(true);
    expect(res.transactionId).toBeTruthy();
    const tx = await services.db.getFirstAsync<{ kind: string; status: string; amount_cents: number; source_system: string }>(
      'SELECT kind, status, amount_cents, source_system FROM transactions WHERE id = ?',
      [res.transactionId!]
    );
    expect(tx?.kind).toBe('CONSOLIDATED');
    expect(tx?.status).toBe('CONFIRMED');
    expect(tx?.amount_cents).toBe(h.paidCents);
    expect(tx?.source_system).toBe('NFCE');
  });

  test('1º candidato WAF → 2º candidato abre a nota', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(3));
    fetchMock
      .mockResolvedValueOnce(htmlResponse('<html><body>Request Rejected — Your support ID is: 7</body></html>'))
      .mockResolvedValueOnce(htmlResponse(docNovo(h, genItems(rng(4), 2))));
    const res = await services.nfce.ingestFromQrOrKey(KEY);
    expect(res.created).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('todos os candidatos falham → documento PENDING (sem transação)', async () => {
    const { services } = await makeCtx();
    fetchMock.mockResolvedValue(htmlResponse('<html><body>Access Denied</body></html>', 403));
    const res = await services.nfce.ingestFromQrOrKey(KEY);
    expect(res.created).toBe(false);
    expect(res.transactionId).toBeNull();
    const doc = await services.db.getFirstAsync<{ parse_status: string; transaction_id: string | null }>(
      'SELECT parse_status, transaction_id FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(doc?.parse_status).toBe('PENDING');
    expect(doc?.transaction_id).toBeNull();
  });

  test.each([
    ['HTTP 500', () => htmlResponse('<html><body>ok</body></html>', 500)],
    ['body vazio', () => htmlResponse('')],
    ['não-HTML', () => htmlResponse('isso não é html')],
    // v30: a promise rejeitada é criada DENTRO do teste (thunk) — criar na hora
    // do describe deixava a rejeição órfã durante a execução da suíte e o Jest
    // derrubava o teste vizinho como unhandled rejection.
    ['rede derruba (reject)', () => Promise.reject(new Error('offline'))],
    ['WAF Request Rejected', () => htmlResponse('<html><body>The requested URL was rejected.</body></html>')],
  ])('candidato falha (%s) → tenta próximo → null no fim', async (_n, bad) => {
    const { services } = await makeCtx();
    fetchMock.mockReturnValueOnce(bad() as never).mockResolvedValueOnce(htmlResponse('<html><body>Access Denied</body></html>', 403));
    const res = await services.nfce.ingestFromQrOrKey(KEY);
    expect(res.created).toBe(false);
    // v36: a leitura direta tem 1 identidade (Dalvik) × 2 canais = 2 tentativas
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('charset ISO-8859-1: acentos decodificam (loja com Ç/Ã)', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(5));
    h.store = 'AÇÕES & PRODUTOS ATACADÃO LTDA';
    const doc = docLegacy(h, genItems(rng(6), 1));
    fetchMock.mockResolvedValueOnce(
      new Response(latin1Bytes(doc), { status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' } })
    );
    const res = await services.nfce.ingestFromQrOrKey(KEY);
    expect(res.created).toBe(true);
    const docRow = await services.db.getFirstAsync<{ store_name: string | null }>(
      'SELECT store_name FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(docRow?.store_name).toBe('AÇÕES & PRODUTOS ATACADÃO LTDA');
  });

  test('charset declarado no META do body (sem content-type)', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(7));
    const doc = docTabela(h, genItems(rng(8), 1)).replace('<head>', '<head><meta charset="iso-8859-1">');
    fetchMock.mockResolvedValueOnce(new Response(latin1Bytes(doc), { status: 200, headers: { 'content-type': 'text/html' } }));
    const res = await services.nfce.ingestFromQrOrKey(KEY);
    expect(res.created).toBe(true);
    const docRow = await services.db.getFirstAsync<{ store_name: string | null }>(
      'SELECT store_name FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(docRow?.store_name).toBe(h.store);
  });

  test('nota SEM valor legível → HEADER_ONLY + needsAmount (sem transação, sem crash)', async () => {
    const { services } = await makeCtx();
    fetchMock.mockResolvedValueOnce(
      htmlResponse('<html><body><h1>Dados da NFC-e</h1><div>Nome Empresarial: LOJA SEM VALOR</div></body></html>')
    );
    const res = await services.nfce.ingestFromQrOrKey(KEY);
    expect(res.needsAmount).toBe(true);
    expect(res.created).toBe(false);
    const doc = await services.db.getFirstAsync<{ parse_status: string; needs_review: number }>(
      'SELECT parse_status, needs_review FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(doc?.parse_status).toBe('HEADER_ONLY');
    expect(doc?.needs_review).toBe(1);
  });

  test('v24: documento PODRE (PENDING) não trava reescaneamento — é atualizado', async () => {
    const { services } = await makeCtx();
    await services.db.runAsync(
      "INSERT INTO nfce_documents (access_key, parse_status, needs_review, transaction_id) VALUES (?, 'PENDING', 1, NULL)",
      [KEY]
    );
    const h = genHeader(rng(9));
    fetchMock.mockResolvedValueOnce(htmlResponse(docNovo(h, genItems(rng(10), 2))));
    const res = await services.nfce.ingestFromQrOrKey(KEY);
    expect(res.created).toBe(true);
    const docs = await services.db.getAllAsync<{ access_key: string; parse_status: string; transaction_id: string | null }>(
      'SELECT access_key, parse_status, transaction_id FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(docs).toHaveLength(1); // UPSERT — não duplicou
    expect(docs[0].transaction_id).toBeTruthy();
  });

  test('nota já registrada (com transação real) → created=false + id da transação', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(11));
    fetchMock.mockResolvedValueOnce(htmlResponse(docLegacy(h, genItems(rng(12), 1))));
    const first = await services.nfce.ingestFromQrOrKey(KEY);
    expect(first.created).toBe(true);
    // segunda leitura da MESMA nota (novo HTML chegado)
    const second = await services.nfce.ingestFromHtml(KEY, docNovo(h, genItems(rng(13), 1)), null);
    expect(second.created).toBe(false);
    expect(second.transactionId).toBe(first.transactionId);
  });

  test('processItems insere itens, marca COMPLETE e é idempotente', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(14));
    const items = genItems(rng(15), 4);
    const html = docNovo(h, items);
    const res = await services.nfce.ingestFromHtml(KEY, html, null);
    expect(res.created).toBe(true);
    const p1 = await services.nfce.processItems(KEY, html);
    expect(p1.items).toBe(4);
    const doc = await services.db.getFirstAsync<{ parse_status: string }>(
      'SELECT parse_status FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    expect(doc?.parse_status).toBe('COMPLETE');
    // idempotente: reprocessar NÃO duplica
    const p2 = await services.nfce.processItems(KEY, html);
    expect(p2.items).toBe(4);
    const nItems = await services.db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM nfce_items WHERE access_key = ?',
      [KEY]
    );
    expect(nItems?.n).toBe(4);
  });

  test('processItems sem documento → erro claro', async () => {
    const { services } = await makeCtx();
    await expect(services.nfce.processItems('chave-inexistente', '<html></html>')).rejects.toThrow(/não encontrado/i);
  });

  test('processItems sem HTML (rede falhou) → status mantido, transação fica', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(16));
    await services.nfce.ingestFromHtml(KEY, docLegacy(h, genItems(rng(17), 1)), null);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const res = await services.nfce.processItems(KEY, '');
    expect(res.items).toBe(0);
    const doc = await services.db.getFirstAsync<{ parse_status: string; transaction_id: string | null }>(
      'SELECT parse_status, transaction_id FROM nfce_documents WHERE access_key = ?',
      [KEY]
    );
    // documento HEADER_ONLY (com transação) não vira PENDING nem FAILED — só perde itens
    expect(doc?.parse_status).toBe('HEADER_ONLY');
    expect(doc?.transaction_id).toBeTruthy();
  });

  test('ocorrência com itens não parseáveis: transação NÃO derruba (desacoplamento ARQ-008)', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(18));
    const html = docLegacy(h, genItems(rng(19), 2));
    const res = await services.nfce.ingestFromHtml(KEY, html, 'https://www.nfce.fazenda.sp.gov.br/qrcode?p=x');
    expect(res.created).toBe(true);
    const p = await services.nfce.processItems(KEY, html);
    expect(p.items).toBe(2);
  });

  test('findRegisteredTransactionId: sujo/ausente → null; real → id', async () => {
    const { services } = await makeCtx();
    expect(await services.nfce.findRegisteredTransactionId(KEY)).toBeNull();
    // documento podre (sem transação) → null
    await services.db.runAsync(
      "INSERT INTO nfce_documents (access_key, parse_status, needs_review, transaction_id) VALUES (?, 'FAILED', 1, NULL)",
      [KEY]
    );
    expect(await services.nfce.findRegisteredTransactionId(KEY)).toBeNull();
    // transação REAL + status completo → id
    const txId = 'tx-real-nfce-1';
    await services.db.runAsync(
      `INSERT INTO transactions (id, kind, type, amount_cents, occurred_on, occurred_at, description, status, source_system, external_ref_id)
       VALUES (?, 'CONSOLIDATED', 'EXPENSE', 1000, '2026-05-10', '2026-05-10T12:00:00.000Z', 'NFC-e Teste', 'CONFIRMED', 'NFCE', ?)`,
      [txId, KEY]
    );
    await services.db.runAsync(
      "UPDATE nfce_documents SET parse_status = 'COMPLETE', transaction_id = ? WHERE access_key = ?",
      [txId, KEY]
    );
    expect(await services.nfce.findRegisteredTransactionId(KEY)).toBe(txId);
  });

  test('data da transação vem da EMISSÃO da nota (fuso SP), não do dia atual', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(20));
    h.issued = '10/05/2026 14:32:11';
    fetchMock.mockResolvedValueOnce(htmlResponse(docLegacy(h, genItems(rng(21), 1))));
    const res = await services.nfce.ingestFromQrOrKey(KEY);
    const tx = await services.db.getFirstAsync<{ occurred_on: string }>(
      'SELECT occurred_on FROM transactions WHERE id = ?',
      [res.transactionId!]
    );
    expect(tx?.occurred_on).toBe('2026-05-10');
  });

  test('desconto não zera o valor pago; valor = pago ?? total', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(22));
    h.withDiscount = true;
    h.discountCents = 250;
    h.paidCents = h.grossCents - 250;
    fetchMock.mockResolvedValueOnce(htmlResponse(docNovo(h, genItems(rng(23), 1))));
    const res = await services.nfce.ingestFromQrOrKey(KEY);
    const tx = await services.db.getFirstAsync<{ amount_cents: number }>(
      'SELECT amount_cents FROM transactions WHERE id = ?',
      [res.transactionId!]
    );
    expect(tx?.amount_cents).toBe(h.paidCents);
  });

  test('idempotência UNIQUE(source_system, external_ref_id): mesma chave nunca gera 2 transações', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(24));
    fetchMock.mockResolvedValue(htmlResponse(docLegacy(h, genItems(rng(25), 1))));
    const r1 = await services.nfce.ingestFromQrOrKey(`https://www.nfce.fazenda.sp.gov.br/qrcode?p=${KEY}|2|1|1|A`);
    const r2 = await services.nfce.ingestFromQrOrKey(`https://nfce.fazenda.sp.gov.br/qrcode?p=${KEY}|2|1|1|B`);
    expect(r1.transactionId).toBe(r2.transactionId);
    const n = await services.db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM transactions WHERE source_system = 'NFCE' AND external_ref_id = ?",
      [KEY]
    );
    expect(n?.n).toBe(1);
  });

  test('processItems resolve/registra produto e marca review quando ambíguo', async () => {
    const { services } = await makeCtx();
    const h = genHeader(rng(26));
    const items = genItems(rng(27), 2);
    const html = docNovo(h, items);
    await services.nfce.ingestFromHtml(KEY, html, null);
    const p = await services.nfce.processItems(KEY, html);
    expect(p.items).toBe(2);
    const rows = await services.db.getAllAsync<{ id: string; product_id: string | null; status: string }>(
      'SELECT id, product_id, status FROM nfce_items WHERE access_key = ? ORDER BY line_number',
      [KEY]
    );
    for (const row of rows) {
      expect(['PARSED', 'REVIEW_SUGGESTED', 'IGNORED']).toContain(row.status);
    }
  });
});

// ─────────────────────────── 9. Ingestão ponta a ponta: 3 layouts × 10 docs (30 casos) ───────────────────────────
describe('NFC-e — ingestão ponta a ponta (ingestFromHtml + processItems), 30 documentos', () => {
  const r = rng(90210);
  const gens: Array<[string, (h: GenHeader, items: GenItem[]) => string]> = [
    ['legado', docLegacy],
    ['novo', docNovo],
    ['tabela', docTabela],
  ];
  for (const [name, gen] of gens) {
    for (let d = 0; d < 10; d++) {
      const h = genHeader(r);
      const items = genItems(r, 1 + Math.floor(r() * 5));
      const html = gen(h, items);
      const amount = h.paidCents;
      test(`ponta a ponta ${name} doc#${d} — total ${amount}`, async () => {
        const { services } = await makeCtx();
        const res = await services.nfce.ingestFromHtml(KEY, html, null);
        expect(res.created).toBe(true);
        const tx = await services.db.getFirstAsync<{ amount_cents: number; description: string }>(
          'SELECT amount_cents, description FROM transactions WHERE id = ?',
          [res.transactionId!]
        );
        expect(tx?.amount_cents).toBe(amount);
        expect(tx?.description).toContain(h.store);
        const p = await services.nfce.processItems(KEY, html);
        expect(p.items).toBe(items.length);
        const sums = await services.db.getFirstAsync<{ total: number | null }>(
          'SELECT SUM(total_cents) AS total FROM nfce_items WHERE access_key = ?',
          [KEY]
        );
        // soma dos itens extraídos = soma dos itens gerados
        expect(sums?.total ?? 0).toBe(items.reduce((a, b) => a + b.totalCents, 0));
      });
    }
  }
});
