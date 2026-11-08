/** Utils — dinheiro (centavos), datas SP e fuzzy. */

import { parseMoneyToCents, formatBRL, divideCents } from '../lib/money';
import { addMonths, monthAdd, effectiveClosingDay, spDateOfIso, lastDayNumberOf, brToYmd, ymdToBr, maskBrDate } from '../lib/dates';
import { levenshteinSimilarity, jaroWinkler, normalizeText, isFuzzyMatch, truncateLabel } from '../lib/text';

describe('money', () => {
  test('parse pt-BR e en-US em centavos (Math.round(input*100))', () => {
    expect(parseMoneyToCents('12,34')).toBe(1234);
    expect(parseMoneyToCents('12.34')).toBe(1234);
    expect(parseMoneyToCents('1.234,56')).toBe(123456);
    expect(parseMoneyToCents('R$ 9,99')).toBe(999);
    expect(parseMoneyToCents('0,01')).toBe(1);
    expect(parseMoneyToCents('abc')).toBe(0);
  });

  test('divideCents conserva o total', () => {
    expect(divideCents(100, 3)).toEqual([33, 33, 34]);
    expect(divideCents(100001, 3).reduce((a, b) => a + b, 0)).toBe(100001);
  });

  test('formatBRL exibe em pt-BR', () => {
    expect(formatBRL(123456)).toContain('1.234,56');
  });
});

describe('dates America/Sao_Paulo', () => {
  test('spDateOfIso converte UTC para data local SP (UTC-3)', () => {
    // 01/05 02:59 UTC = 31/04 23:59 SP (UTC-3)... na verdade 30/04 23:59 SP
    expect(spDateOfIso('2026-05-01T02:59:59.000Z')).toBe('2026-04-30');
    // 01/05 03:00 UTC = 01/05 00:00 SP
    expect(spDateOfIso('2026-05-01T03:00:00.000Z')).toBe('2026-05-01');
  });

  test('addMonths com clamp de fim de mês', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29'); // bissexto
    expect(addMonths('2026-03-15', 11)).toBe('2027-02-15');
  });

  test('monthAdd mantém YYYY-MM', () => {
    expect(monthAdd('2026-12', 1)).toBe('2027-01');
    expect(monthAdd('2026-01', -1)).toBe('2025-12');
  });

  test('closing_day clampado ao último dia do mês', () => {
    expect(effectiveClosingDay('2026-04', 31)).toBe(30);
    expect(effectiveClosingDay('2026-02', 31)).toBe(28);
    expect(lastDayNumberOf('2024-02')).toBe(29);
  });

  test('ymdToBr exibe dd/mm/aaaa', () => {
    expect(ymdToBr('2026-03-07')).toBe('07/03/2026');
    expect(ymdToBr('2026-12-31')).toBe('31/12/2026');
  });

  test('brToYmd aceita dd/mm/aaaa, ddmmyyyy e aaaa-mm-dd (v7.0.4)', () => {
    expect(brToYmd('07/03/2026')).toBe('2026-03-07');
    expect(brToYmd('7/3/2026')).toBe('2026-03-07');
    expect(brToYmd('07032026')).toBe('2026-03-07');
    expect(brToYmd('2026-03-07')).toBe('2026-03-07'); // colado de fora
    expect(brToYmd('29/02/2024')).toBe('2024-02-29'); // bissexto
  });

  test('brToYmd rejeita data inválida/incompleta', () => {
    expect(brToYmd('31/02/2026')).toBeNull(); // fevereiro não tem 31
    expect(brToYmd('13/13/2026')).toBeNull();
    expect(brToYmd('31/12')).toBeNull(); // incompleta
    expect(brToYmd('')).toBeNull();
    expect(brToYmd('abc')).toBeNull();
  });

  test('maskBrDate formata enquanto digita', () => {
    expect(maskBrDate('07')).toBe('07');
    expect(maskBrDate('0703')).toBe('07/03');
    expect(maskBrDate('07032026')).toBe('07/03/2026');
    expect(maskBrDate('07/03/20269999')).toBe('07/03/2026'); // trava em 8 dígitos
  });
});

describe('fuzzy (thresholds da spec v7)', () => {
  test('normalização remove acentos e espaços extras', () => {
    expect(normalizeText('  AÇÚCAR   REFINADO ')).toBe('acucar refinado');
  });

  test('isFuzzyMatch respeita Levenshtein > 0.90 / JW > 0.92', () => {
    expect(isFuzzyMatch('LEITE INTEGRAL 1L', 'LEITE INTEGRAL 1L')).toBe(true);
    expect(isFuzzyMatch('ACUCAR REFINADO UNIAO 1KG', 'Açúcar Refinado União 1kg')).toBe(true);
    expect(isFuzzyMatch('SABONETE DOVE', 'PIPOCA DE MICROONDAS')).toBe(false);
  });

  test('similaridades em [0,1]', () => {
    const s = levenshteinSimilarity('abc', 'abc');
    expect(s).toBe(1);
    expect(jaroWinkler('martha', 'marhta')).toBeGreaterThan(0.9);
  });
});

describe('truncateLabel (botões do diálogo de exclusão — v7.0.6)', () => {
  test('nome curto passa intacto; longo é truncado com reticências', () => {
    expect(truncateLabel('Aluguel')).toBe('Aluguel');
    expect(truncateLabel('Assinatura streaming família', 20)).toBe('Assinatura streaming…');
    expect(truncateLabel('', 20)).toBe('—');
    expect(truncateLabel(null, 20)).toBe('—');
    expect(truncateLabel('  Espaços  ', 20)).toBe('Espaços');
  });
});
