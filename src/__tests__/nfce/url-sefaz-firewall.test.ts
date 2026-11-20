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

describe('v23/v39.1 listConsultUrls — apenas o link oficial do QR', () => {
  test('fila de 1 canal: ConsultaQRCode.aspx?p=chave|3|1', () => {
    const raw = 'https://www.nfce.fazenda.sp.gov.br/qrcode?p=35261107216883000121650010000636851006368500|2|1|1|SIG';
    const key = extractAccessKey(raw)!;
    expect(key).toBe('35261107216883000121650010000636851006368500');
    const urls = listConsultUrls(raw, key);
    expect(urls).toEqual([
      'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=35261107216883000121650010000636851006368500%7C3%7C1',
    ]);
    expect(urls.length).toBe(1);
    expect(urls[0]).not.toContain('|');
    expect(urls[0]).not.toContain('chaveAcesso=');
  });

  test('QR de domínio curto não altera a fila — ainda o canônico .br', () => {
    const raw = 'https://www.nfce.fazenda.sp.gov/qrcode?p=35261057032427001160651100000311141318831362|3|1';
    const key = extractAccessKey(raw)!;
    const urls = listConsultUrls(raw, key);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx');
    expect(urls[0]).not.toContain('sp.gov/qrcode');
  });
});

describe('v23 marcação da nota (looksLikeNfcePage — reexport)', () => {
  test('helper de nota presente', () => {
    expect(typeof looksLikeNfceNoteHtml).toBe('function');
  });
});
