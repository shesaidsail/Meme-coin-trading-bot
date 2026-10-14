import { describe, it, expect } from 'vitest';
import { holderConcentrationFilter } from '../../../src/filters/holder-concentration.js';
import { makeCtx, cleanReport, abuMintInfo } from '../../helpers/filter-ctx.js';

const SUPPLY = abuMintInfo().supply;
const amt = (f: number) => BigInt(Math.round(Number(SUPPLY) * f));

describe('holderConcentration filter', () => {
  it('falls back to RugCheck holders and excludes the pool (real data: top10 ~25.6%)', async () => {
    const r = await holderConcentrationFilter.check(makeCtx().ctx);
    expect(r.status).toBe('pass');
    expect(r.data).toMatchObject({ source: 'rugcheck', excludedCount: 1 });
    expect(r.data!.top10Fraction as number).toBeCloseTo(0.2564, 3);
  });

  it('uses on-chain largest accounts when available, aggregated by owner', async () => {
    const r = await holderConcentrationFilter.check(
      makeCtx({
        largest: [
          { address: 'acc1', amount: amt(0.03) },
          { address: 'acc2', amount: amt(0.03) },
          { address: 'poolVault', amount: amt(0.4) },
        ],
        owners: new Map([
          ['acc1', 'whale'],
          ['acc2', 'whale'],
          ['poolVault', '2qWF4dn1JnqhCpAYJQnKVaKezzuUiG4xdnbnCSK1Pgcw'],
        ]),
      }).ctx,
    );
    expect(r.status).toBe('fail');
    expect(r.data).toMatchObject({ source: 'onchain', excludedCount: 1 });
    expect(r.reason).toMatch(/wallet whale holds 6\.0%/);
  });

  it('fails on top-10 concentration', async () => {
    const report = cleanReport();
    report.topHolders = Array.from({ length: 10 }, (_, i) => ({ address: `a${i}`, owner: `o${i}`, amount: 1, pct: 4, insider: false }));
    const r = await holderConcentrationFilter.check(makeCtx({ report }).ctx);
    expect(r.reason).toMatch(/top 10 holders own 40\.0%/);
  });

  it('excludes configured burn addresses', async () => {
    const report = cleanReport();
    report.topHolders = [{ address: 'x', owner: '1nc1nerator11111111111111111111111111111111', amount: 1, pct: 50, insider: false }];
    expect((await holderConcentrationFilter.check(makeCtx({ report }).ctx)).status).toBe('pass');
  });

  it('is missing when neither source has holders', async () => {
    const r = await holderConcentrationFilter.check(makeCtx({ report: { ...cleanReport(), topHolders: [] } }).ctx);
    expect(r.status).toBe('missing');
  });
});
