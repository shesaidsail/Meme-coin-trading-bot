/**
 * Amount handling. On-chain amounts are integers (lamports, raw token units)
 * and are kept as bigint end to end; they are only converted to floating
 * point for display and for ratio comparisons.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Fixed-point scale for multiplying bigints by fractional factors. */
const SCALE = 1_000_000_000_000n; // 1e12

export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol)) throw new RangeError(`invalid SOL amount: ${sol}`);
  // Go through a fixed-precision string to avoid float artefacts (0.1 SOL → 100000000).
  const [whole, frac = ''] = sol.toFixed(9).split('.');
  const sign = whole!.startsWith('-') ? -1n : 1n;
  const w = BigInt(whole!.replace('-', ''));
  return sign * (w * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, '0')));
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

/** amount * factor, rounded toward zero. factor is a non-negative float. */
export function mulFrac(amount: bigint, factor: number): bigint {
  if (!Number.isFinite(factor) || factor < 0) throw new RangeError(`invalid factor: ${factor}`);
  const f = BigInt(Math.round(factor * Number(SCALE)));
  return (amount * f) / SCALE;
}

/** a / b as a float. Returns NaN when b is zero. */
export function ratio(a: bigint, b: bigint): number {
  if (b === 0n) return Number.NaN;
  // Scale before dividing to keep precision for large values.
  return Number((a * SCALE) / b) / Number(SCALE);
}

export function bpsToFraction(bps: number): number {
  return bps / 10_000;
}

/** Parses a non-negative integer amount stored as a decimal string. */
export function parseAmount(s: string): bigint {
  if (!/^\d+$/.test(s)) throw new RangeError(`invalid amount: ${JSON.stringify(s)}`);
  return BigInt(s);
}

export function formatSol(lamports: bigint, digits = 4): string {
  return `${lamportsToSol(lamports).toFixed(digits)} SOL`;
}

export function formatUsd(usd: number): string {
  const sign = usd < 0 ? '-' : '';
  return `${sign}$${Math.abs(usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
