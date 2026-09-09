import type { UsageLine } from './contracts.js';
export interface PriceSnapshot {
  version: string;
  currency: string;
  rates: Record<string, string>;
}
export function actualCost(
  pricing: PriceSnapshot | undefined,
  lines: UsageLine[],
  complete: boolean,
): bigint | null {
  if (!pricing || pricing.currency !== 'USD' || !complete || !lines.length) return null;
  let numerator = 0n;
  const seen = new Set<string>();
  for (const line of lines) {
    const rate = pricing.rates[line.dimension];
    if (
      seen.has(line.dimension) ||
      line.unit !== 'token' ||
      !['response', 'invoice'].includes(line.source) ||
      !/^\d+$/.test(line.quantity) ||
      rate === undefined ||
      !/^\d+$/.test(rate)
    )
      return null;
    seen.add(line.dimension);
    numerator += BigInt(rate) * BigInt(line.quantity);
  }
  return (numerator + 999_999n) / 1_000_000n;
}
