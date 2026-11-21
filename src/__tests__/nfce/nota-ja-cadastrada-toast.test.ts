/**
 * v101 — NOVO LANÇAMENTO > NFC-e: quando o QR resolve para uma nota JÁ
 *  cadastrada (findRegisteredTransactionId !== null ou prepareFromDocument
 *  devolve alreadyRegistered=true), a tela do modal mostra APENAS o toast
 *  "NFC já cadastrada" (estilo `ok` — preto padrão) e fecha o modal. Sem
 *  navegar para /nfce/[key].
 *
 * Lê o fonte da tela principal `app/lancamento.tsx` e verifica:
 *  - o caminho `ingestNfce` mostra `showToast('NFC já cadastrada')`;
 *  - NÃO chama `router.push('/nfce/...'`) ao detectar a nota já cadastrada.
 *  - `applyPreparedNote` (alreadyRegistered) também emite o toast padrão.
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..', '..', '..');
const launchSrc = fs.readFileSync(path.join(root, 'app', 'lancamento.tsx'), 'utf8');

describe('v101 — NFCe já cadastrada no Novo Lançamento = só toast', () => {
  test('ingestNfce mostra "NFC já cadastrada" e fecha o modal', () => {
    // O trecho novo usa showToast('NFC já cadastrada') ANTES do setScannerOpen(false).
    expect(launchSrc).toContain("showToast('NFC já cadastrada')");
  });
  test('ingestNfce NÃO chama router.push("/nfce/...") quando já cadastrada', () => {
    // Pega o trecho que COMEÇA com `if (registeredId) {` e verifica que ele
    // NÃO contém router.push('/nfce/...'). Mais barato: o path /nfce/ não
    // pode aparecer dentro do bloco do `registeredId`.
    const re = /if\s*\(\s*registeredId\s*\)\s*\{[\s\S]*?return\s*;[\s\S]*?\}/m;
    const block = launchSrc.match(re);
    expect(block).toBeTruthy();
    expect(block![0]).not.toMatch(/router\.push\(\s*`\/nfce\//);
    expect(block![0]).toContain("showToast('NFC já cadastrada')");
  });
  test('applyPreparedNote (alreadyRegistered) usa toast padrão (não "err")', () => {
    // O caminho é `if (prepared.alreadyRegistered) {` — pega esse bloco.
    const re = /if\s*\(\s*prepared\.alreadyRegistered\s*\)\s*\{[\s\S]*?return\s*false\s*;[\s\S]*?\}/m;
    const block = launchSrc.match(re);
    expect(block).toBeTruthy();
    expect(block![0]).toContain("showToast('NFC já cadastrada')");
    // Sem rota para /nfce/ dentro do bloco `alreadyRegistered`.
    expect(block![0]).not.toMatch(/router\.push\(\s*`\/nfce\//);
  });
});
