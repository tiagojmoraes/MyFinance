/**
 * v72 — CONSOLIDADO CALCULA O VALOR (pedido do usuário): no Novo Lançamento,
 * o tipo "Consolidado" agora mostra o valor CALCULADO do grupo como os outros
 * tipos mostram o deles. O helper puro (src/lib/consolidado.ts) soma TODAS as
 * linhas — à vista inteira, fixa mensal, parcela do mês — e a tela exibe o
 * "Resumo do grupo (calculado)" −débitos · +créditos, atualizando a cada
 * digitação.
 *  Roda: npx jest src/__tests__/consolidado-calcula-valor.test.ts
 */

import { consolidatedGroupTotals, lineMonthlyCents } from '../../lib/consolidado';
import { divideCents } from '../../lib/money';
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..', '..', '..');
const readSrc = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('v72 — Consolidado calcula o valor (helper puro)', () => {
  test('à vista e fixa entram inteiras; parcelado entra a PARCELA do mês', () => {
    // à vista 100 no débito + fixa 200 no débito
    const t1 = consolidatedGroupTotals([
      { dir: 'DEBIT', cents: 10_000, modality: 'AVISTA' },
      { dir: 'DEBIT', cents: 20_000, modality: 'FIXO' },
    ]);
    expect(t1.debitCents).toBe(30_000); // 100 + 200 (fixa entra todo mês)
    expect(t1.creditCents).toBe(0);

    // parcela fixa: 2.000 por 10 meses → parcela do mês = 2.000 (não 20.000)
    const t2 = consolidatedGroupTotals([
      { dir: 'DEBIT', cents: 2_000, modality: 'PARCELADO', planMode: 'FIXED_PER_MONTH', parcelas: '10' },
    ]);
    expect(t2.debitCents).toBe(2_000);

    // dividir total: 10.000 em 5x → parcela do mês = 2.000 (a 1ª do reparte)
    const t3 = consolidatedGroupTotals([
      { dir: 'DEBIT', cents: 10_000, modality: 'PARCELADO', planMode: 'DIVIDE_TOTAL', parcelas: '5' },
    ]);
    expect(t3.debitCents).toBe(divideCents(10_000, 5)[0]);
    expect(t3.debitCents).toBe(2_000);
  });

  test('linhas de lados opostos somam SEPARADAS (−débitos / +créditos)', () => {
    const t = consolidatedGroupTotals([
      { dir: 'DEBIT', cents: 1_000, modality: 'AVISTA' },
      { dir: 'DEBIT', cents: 500, modality: 'FIXO' },
      { dir: 'CREDIT', cents: 300, modality: 'AVISTA' },
      { dir: 'CREDIT', cents: 7_000, modality: 'PARCELADO', planMode: 'FIXED_PER_MONTH', parcelas: '36' },
    ]);
    expect(t.debitCents).toBe(1_500);
    expect(t.creditCents).toBe(7_300);
    expect(t.lineCount).toBe(4);
    expect(t.fixoCount).toBe(1);
    expect(t.parceladoCount).toBe(1);
  });

  test('linhas zeradas não contam; parcelas inválidas caem no valor cru (não quebram)', () => {
    const t = consolidatedGroupTotals([
      { dir: 'DEBIT', cents: 0, modality: 'AVISTA' },
      { dir: 'DEBIT', cents: 1_200, modality: 'PARCELADO', planMode: 'DIVIDE_TOTAL', parcelas: 'abc' },
    ]);
    expect(t.lineCount).toBe(1);
    expect(t.debitCents).toBe(1_200);
    expect(lineMonthlyCents({ dir: 'DEBIT', cents: 1_200, modality: 'PARCELADO', parcelas: null })).toBe(1_200);
  });

  test('resto de centavos do reparte: a 1ª parcela é a que entra no mês', () => {
    // 1.000 em 3x → [333, 333, 334] (resto na ÚLTIMA, como no Parcelado simples);
    // no mês do grupo entra a 1ª do reparte
    expect(lineMonthlyCents({ dir: 'DEBIT', cents: 1_000, modality: 'PARCELADO', planMode: 'DIVIDE_TOTAL', parcelas: '3' })).toBe(333);
  });
});

describe('Consolidado — os cálculos continuam disponíveis sem resumo visual', () => {
  test('remove o resumo visual e preserva o cálculo de totais', () => {
    const src = readSrc('app/lancamento.tsx');
    expect(src).not.toContain('Resumo do grupo (calculado)');
    expect(src).toContain('consolidatedGroupTotals(lines)');
    expect(src).toContain('const debitTotal = grupoTotais.debitCents;');
    expect(src).toContain('const creditTotal = grupoTotais.creditCents;');
  });
});
