/** v60 — PRÉ-VOO: todos os erros de inicialização já mapeados
 *  Garante: expo SDK alvo declarado, sem query-string (removida na v91 porque
 *  expo-router 58 não usa mais), sem duplicatas, scripts de 2 terminais existem,
 *  check-inicializacao existe.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('v60 PRÉ-VOO — inicialização sem erro', () => {
  const root = path.join(__dirname, '..', '..', '..');
  test('v91 package.json no SDK 58 (expo e expo-router), SEM query-string', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    // v91: query-string saiu (expo-router 58 não depende mais dela, e Hermes
    // 0.88 já aceita o regex da v9 — a trava do SDK 53 virou desnecessária).
    expect(pkg.dependencies['query-string']).toBeUndefined();
    expect(pkg.dependencies['expo']).toMatch(/^(?:~)?58\./);
    expect(pkg.dependencies['expo-router']).toMatch(/^~58\./);
    expect(pkg.dependencies['react-native']).toMatch(/^0\.88\./);
    expect(pkg.dependencies['react']).toMatch(/^19\.3\./);
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
  test('AGENTS.md documenta versões travadas e a regra de testes', () => {
    const txt = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    // AGENTS.md reescrito (fonte única): a seção "Versões travadas" documenta
    // o motivo de cada pin — expo 58.0.23, RN 0.88.1, jest 29 (Jest 30 + TS 6
    // quebrou test.each) — e a seção 5 guarda a regra de não rodar testes.
    for (const marco of ['## 5. Testes', '## 5.1 Versões travadas', 'expo 58.0.23', 'react-native 0.88.1', 'jest ^29.7.0', 'npm install']) {
      expect(txt).toContain(marco);
    }
  });
});
