export function subtractAllocationsCents(balanceCents: number, allocations: number[]): number {
  const reservedCents = allocations.reduce(
    (total, amount) => total + (Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)) : 0),
    0
  );
  return Math.trunc(balanceCents) - reservedCents;
}
