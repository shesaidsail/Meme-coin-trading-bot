import { describe, it, expect } from 'vitest';
import { solToLamports, lamportsToSol, mulFrac, ratio, parseAmount, formatUsd } from '../../src/util/units.js';

describe('units', () => {
  it('converts SOL to lamports without float artefacts', () => {
    expect(solToLamports(10)).toBe(10_000_000_000n);
    expect(solToLamports(0.1)).toBe(100_000_000n);
    expect(solToLamports(0.3)).toBe(300_000_000n);
    expect(solToLamports(1.000000001)).toBe(1_000_000_001n);
    expect(lamportsToSol(1_500_000_000n)).toBe(1.5);
  });

  it('multiplies bigints by fractions', () => {
    expect(mulFrac(10_000_000_000n, 0.05)).toBe(500_000_000n);
    expect(mulFrac(10n ** 18n, 0.5)).toBe(5n * 10n ** 17n);
    expect(() => mulFrac(1n, -1)).toThrow();
  });

  it('computes ratios with precision for large values', () => {
    expect(ratio(1n, 4n)).toBe(0.25);
    expect(ratio(10n ** 19n, 4n * 10n ** 19n)).toBe(0.25);
    expect(ratio(1n, 0n)).toBeNaN();
  });

  it('parses stored amounts strictly', () => {
    expect(parseAmount('18446744073709551615')).toBe(18446744073709551615n); // u64 max
    expect(() => parseAmount('-1')).toThrow();
    expect(() => parseAmount('1.5')).toThrow();
  });

  it('formats USD', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(-3)).toBe('-$3.00');
  });
});
