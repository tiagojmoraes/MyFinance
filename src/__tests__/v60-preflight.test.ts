/** v60 — PRÉ-VOO: todos os erros de inicialização já mapeados
 *  Roda: npm run test:bateria60
 *  Garante: query-string travado em 7.x (a v9 quebra o Hermes), sem duplicatas,
 *  scripts de 2 terminais existem, check-inicializacao existe.
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
  test('Scripts de 2 terminais existem (servidor à parte, do jeito do usuário)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['dev:servidor']).toContain('servidor-nfce');
    expect(pkg.scripts['dev:expo8082']).toContain('8082');
    expect(pkg.scripts['check']).toContain('check-inicializacao');
  });
  test('Sem arquivos duplicados que confundem o Metro (_layout_1, produtos_1, package_N)', () => {
    expect(fs.existsSync(path.join(root, 'app', '_layout_1.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'app', 'produtos_1.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'metro.config_1.js'))).toBe(false);
    const dup = fs.readdirSync(root).filter((f) => /^package_\\d+\\.json$/.test(f));
    expect(dup).toEqual([]);
  });
  test('check-inicializacao.js existe e checa query-string + pasta + portas', () => {
    const txt = fs.readFileSync(path.join(root, 'tools', 'check-inicializacao.js'), 'utf8');
    expect(txt).toContain('query-string');
    expect(txt).toContain('3000');
    expect(txt).toContain('8082');
    expect(txt).toContain('OneDrive');
  });
  test('COMEÇAR-AQUI.md existe e documenta todos os erros já vistos', () => {
    const txt = fs.readFileSync(path.join(root, 'COMEÇAR-AQUI.md'), 'utf8');
    for (const erro of ['expo@58', 'EADDRINUSE', 'query-string', 'hermes', 'Request Rejected', 'QR']) {
      expect(txt).toContain(erro);
    }
  });
});
