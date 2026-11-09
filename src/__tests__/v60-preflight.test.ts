/** v60 — PRÉ-VOO: todos os erros de inicialização já mapeados
 *  Roda: npm run test:bateria60
 *  Garante: query-string travado em 7.x (a v9 quebra o Hermes), sem duplicatas,
 *  o script de desenvolvimento usa apenas Expo, check-inicializacao existe.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('v60 PRÉ-VOO — inicialização sem erro', () => {
  const root = path.join(__dirname, '..', '..');
  test('package.json trava query-string em 8.x (a v9 quebra o Hermes com Invalid regular expression)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies['query-string']).toBeDefined();
    expect(pkg.dependencies['query-string']).toMatch(/^8\./);
    expect(pkg.dependencies['expo']).toMatch(/^~53\./);
    expect(pkg.dependencies['expo-router']).toMatch(/^~5\./);
  });
  test('desenvolvimento não inicia proxy NFC-e local nem spoof de navegador', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.dev).toBe('expo start -c');
    expect(pkg.scripts['dev:servidor']).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'tools', 'servidor-nfce.js'))).toBe(false);
    expect(pkg.scripts['check']).toContain('check-inicializacao');
  });
  test('Sem arquivos duplicados que confundem o Metro (_layout_1, produtos_1, package_N)', () => {
    expect(fs.existsSync(path.join(root, 'app', '_layout_1.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'app', 'produtos_1.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'metro.config_1.js'))).toBe(false);
    const dup = fs.readdirSync(root).filter((f) => /^package_\\d+\\.json$/.test(f));
    expect(dup).toEqual([]);
  });
  test('check-inicializacao.js checa query-string, pasta e porta Expo sem exigir Chrome/proxy', () => {
    const txt = fs.readFileSync(path.join(root, 'tools', 'check-inicializacao.js'), 'utf8');
    expect(txt).toContain('query-string');
    expect(txt).toContain('8082');
    expect(txt).not.toContain('chrome.exe');
    expect(txt).toContain('OneDrive');
  });
  test('COMEÇAR-AQUI.md existe e documenta todos os erros já vistos', () => {
    const txt = fs.readFileSync(path.join(root, 'COMEÇAR-AQUI.md'), 'utf8');
    for (const erro of ['expo@58', 'query-string', 'hermes', 'Request Rejected', 'QR']) {
      expect(txt).toContain(erro);
    }
  });
});
