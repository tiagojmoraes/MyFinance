/**
 * v101 — Tel a Catálogo de Produto (carrossel com 4 abas).
 *
 * Lê o fonte de `app/produtos.tsx` e verifica se as 4 abas estão lá e se os
 * campos da regra estão presentes (origin, stock_control, status) — sem
 * renderizar React (teste barato, sem React Native Testing Library).
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..', '..', '..');
const src = fs.readFileSync(path.join(root, 'app', 'produtos.tsx'), 'utf8');

describe('v101 — app/produtos.tsx: carrossel com 4 abas', () => {
  test('renderiza Segmented<Tab> com as 4 abas', () => {
    expect(src).toMatch(/<Segmented<Tab>\s+options=\{tabOptions\}\s+value=\{tab\}\s+onChange=\{setTab\}\s*\/>/);
    expect(src).toContain("value: 'PENDENTES'");
    expect(src).toContain("value: 'COM_ESTOQUE'");
    expect(src).toContain("value: 'SEM_ESTOQUE'");
    expect(src).toContain("value: 'INATIVO'");
  });
  test('rótulos das 4 abas estão escritos em português', () => {
    expect(src).toMatch(/Pendentes\s*\(/);
    expect(src).toMatch(/Com Estoque\s*\(/);
    expect(src).toMatch(/Sem Estoque\s*\(/);
    expect(src).toMatch(/Inativo\|Exclu[^,]+\(/);
  });
  test('filtro de cada aba exige origin=USER (AUTO-NFCE não aparece em Com/Sem)', () => {
    // userDecided só aceita produtos com origin = 'USER'.
    expect(src).toContain("(p.origin ?? 'NFCE') === 'USER'");
    // Com Estoque: stock_control = 1 + ativo + USER.
    expect(src).toMatch(/userDecided\(p\)\s*&&\s*ativo\(p\)\s*&&\s*\(p\.stock_control\s*\?\?\s*0\)\s*===\s*1/);
  });
  test('ProductRow declarado com campo origin (v101)', () => {
    expect(src).toMatch(/origin\?:\s*'USER'\s*\|\s*'NFCE'\s*\|\s*null/);
  });
});
