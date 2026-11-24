/**
 * v103 — Tela Catálogo de Produto (carrossel com 3 abas + sub-seletor Com/Sem).
 *
 * Lê o fonte de `app/produtos.tsx` e verifica as abas e os campos da regra
 * (origin, stock_control, status) — sem renderizar React (teste barato, sem
 * React Native Testing Library). v101 tinha 4 abas; a v103 reuniu Com/Sem
 * dentro de CLASSIFICADOS (v106 transformou a separação em sub-seletor).
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(root, 'app', 'produtos.tsx'), 'utf8');

describe('v103 — app/produtos.tsx: carrossel com 3 abas', () => {
  test('renderiza Segmented<Tab> com as 3 abas', () => {
    expect(src).toMatch(/<Segmented<Tab>\s+options=\{tabOptions\}\s+value=\{tab\}\s+onChange=\{setTab\}\s*\/>/);
    expect(src).toContain("value: 'PENDENTES'");
    expect(src).toContain("value: 'CLASSIFICADOS'");
    expect(src).toContain("value: 'INATIVO'");
  });
  test('rótulos das 3 abas estão escritos em português', () => {
    expect(src).toMatch(/Pendentes\s*\(/);
    expect(src).toMatch(/Classificados\s*\(/);
    expect(src).toMatch(/Inativo\|Exclu[^,]+\(/);
  });
  test('sub-seletor Com/Sem estoque dentro de Classificados (v106)', () => {
    expect(src).toContain("<Segmented<'COM' | 'SEM'>");
    expect(src).toContain('Com Estoque (${classifiedProdutos.comEstoque.length})');
    expect(src).toContain('Sem Estoque (${classifiedProdutos.semEstoque.length})');
  });
  test('filtro exige origin=USER e separa por stock_control (AUTO-NFCE não aparece em Com/Sem)', () => {
    // userDecided só aceita produtos com origin = 'USER'; a separação Com/Sem
    // é pelos campos do próprio produto, em memória (sem query em loop).
    expect(src).toContain("(p.origin ?? 'NFCE') === 'USER'");
    expect(src).toMatch(/userDecided\(p\)\s*&&\s*ativo\(p\)\s*&&\s*match\(p\)/);
    expect(src).toMatch(/comEstoque:\s*list\.filter\(\(p\) => \(p\.stock_control \?\? 0\) === 1\)/);
    expect(src).toMatch(/semEstoque:\s*list\.filter\(\(p\) => \(p\.stock_control \?\? 0\) === 0\)/);
  });
  test('ProductRow declarado com campo origin (v101)', () => {
    expect(src).toMatch(/origin\?:\s*'USER'\s*\|\s*'NFCE'\s*\|\s*null/);
  });
});
