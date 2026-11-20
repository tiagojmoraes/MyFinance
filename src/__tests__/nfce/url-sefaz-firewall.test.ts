/** v23 — NFC-e: sanitização da URL do QR + detecção de rejeição do firewall. */
import { sanitizeSefazUrl, isFirewallRejectionPage, listConsultUrls, extractAccessKey, looksLikeNfceNoteHtml } from './nfceTestHelpers';

describe('v23 sanitizeSefazUrl', () => {
  test('codifica | cru do QR da SEFAZ-SP para %7C', () => {
    const raw = 'https://www.nfce.fazenda.sp.gov.br/qrcode?p=35261107216883000121650010000636851006368500|2|1|1|A1B2C3D4';
    const out = sanitizeSefazUrl(raw);
    expect(out).toBe('https://www.nfce.fazenda.sp.gov.br/qrcode?p=35261107216883000121650010000636851006368500%7C2%7C1%7C1%7CA1B2C3D4');
  });

  test('não dupla-codifica %7C já codificado', () => {
    const raw = 'https://www.nfce.fazenda.sp.gov.br/qrcode?p=ABC%7C2%7C1';
    expect(sanitizeSefazUrl(raw)).toBe(raw);
  });

  test('preserva & = + e alfanuméricos', () => {
    const raw = 'https://portal.example.com/Consulta?a=1&b=x+y|z';
    expect(sanitizeSefazUrl(raw)).toBe('https://portal.example.com/Consulta?a=1&b=x+y%7Cz');
  });

  test('URL sem query volta igual (trim)', () => {
    expect(sanitizeSefazUrl('  https://www.sefaz.sp.gov.br/  ')).toBe('https://www.sefaz.sp.gov.br/');
  });
});

describe('v23 isFirewallRejectionPage', () => {
  test('reconhece a página de rejeição do F5 (screenshot do usuário)', () => {
    const html = '<html><body><h1>The requested URL was rejected. Please consult with your administrator.</h1><p>Your support ID is: 10138580085930729183</p><a href="#">[Go Back]</a></body></html>';
    expect(isFirewallRejectionPage(html)).toBe(true);
  });

  test('a página da NOTA nunca é considerada rejeição', () => {
    const html = '<html><body>Nota Fiscal do Consumidor Eletrônica — Valor Total R$ 1.234,56</body></html>';
    expect(isFirewallRejectionPage(html)).toBe(false);
  });
});

describe('v100 listConsultUrls — fila de 3 canais', () => {
  const KEY = '35261107216883000121650010000636851006368500';

  test('URL escaneada assinada primeiro (sanitizada), depois QR canônico e consulta pública', () => {
    const raw = `https://www.nfce.fazenda.sp.gov.br/qrcode?p=${KEY}|2|1|1|SIG`;
    const key = extractAccessKey(raw)!;
    expect(key).toBe(KEY);
    const urls = listConsultUrls(raw, key);
    expect(urls).toEqual([
      `https://www.nfce.fazenda.sp.gov.br/qrcode?p=${KEY}%7C2%7C1%7C1%7CSIG`,
      `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${KEY}%7C3%7C1`,
      `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaPublica.aspx?chaveAcesso=${KEY}`,
    ]);
    urls.forEach((u) => expect(u).not.toContain('|')); // v23: | cru derruba a conexão
  });

  test('QR de domínio curto entra sanitizado na frente, seguido dos canônicos .br', () => {
    const raw = `https://www.nfce.fazenda.sp.gov/qrcode?p=${KEY}|3|1`;
    const key = extractAccessKey(raw)!;
    const urls = listConsultUrls(raw, key);
    expect(urls[0]).toContain('https://www.nfce.fazenda.sp.gov/qrcode?p=');
    expect(urls[0]).toContain('%7C3%7C1');
    expect(urls.slice(1)).toEqual([
      `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${KEY}%7C3%7C1`,
      `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaPublica.aspx?chaveAcesso=${KEY}`,
    ]);
  });

  test('só a chave colada → fila de 2 canais (QR canônico, consulta pública)', () => {
    const urls = listConsultUrls(KEY, KEY);
    expect(urls).toEqual([
      `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${KEY}%7C3%7C1`,
      `https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaPublica.aspx?chaveAcesso=${KEY}`,
    ]);
  });
});

describe('v23 marcação da nota (looksLikeNfcePage — reexport)', () => {
  test('helper de nota presente', () => {
    expect(typeof looksLikeNfceNoteHtml).toBe('function');
  });
});
