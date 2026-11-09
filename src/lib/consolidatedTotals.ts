export interface ConsolidatedLineAmount {
  dir: 'DEBIT' | 'CREDIT';
  cents: number;
}

export function sumConsolidatedLineAmounts(lines: readonly ConsolidatedLineAmount[]): {
  debitCents: number;
  creditCents: number;
} {
  return lines.reduce(
    (totals, line) => {
      const cents = Number.isFinite(line.cents) ? Math.trunc(line.cents) : 0;
      if (line.dir === 'DEBIT') totals.debitCents += cents;
      else totals.creditCents += cents;
      return totals;
    },
    { debitCents: 0, creditCents: 0 }
  );
}
