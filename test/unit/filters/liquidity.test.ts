import { describe, it, expect } from 'vitest';
import { liquidityFilter } from '../../../src/filters/liquidity.js';
import { makeCtx, abuCandidate } from '../../helpers/filter-ctx.js';

const primary = (liquidityUsd: number | null) => ({ primaryPair: { ...abuCandidate().primaryPair, liquidityUsd } });

describe('liquidity filter', () => {
  it('passes the real ABU pair (~$49k, ~22% of mcap)', async () => {
    expect((await liquidityFilter.check(makeCtx().ctx)).status).toBe('pass');
  });

  it('fails below the minimum liquidity', async () => {
    const r = await liquidityFilter.check(makeCtx({ candidate: primary(30_000) }).ctx);
    expect(r).toMatchObject({ status: 'fail' });
    expect(r.reason).toMatch(/\$30,000 < \$40,000/);
  });

  it('fails below the liquidity / market cap ratio', async () => {
    const r = await liquidityFilter.check(makeCtx({ candidate: { ...primary(45_000), marketCapUsd: 600_000 } }).ctx);
    expect(r.status).toBe('fail');
    expect(r.reason).toMatch(/liquidity\/mcap 7\.5% < 10\.0%/);
  });

  it('reports missing data when there is no liquidity figure', async () => {
    expect((await liquidityFilter.check(makeCtx({ candidate: primary(null) }).ctx)).status).toBe('missing');
  });

  it('respects configured thresholds', async () => {
    const r = await liquidityFilter.check(makeCtx({ config: { filters: { liquidity: { minLiquidityUsd: 60_000 } } } }).ctx);
    expect(r.status).toBe('fail');
  });
});
