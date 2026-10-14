import { describe, it, expect } from 'vitest';
import { lpLockedFilter } from '../../../src/filters/lp-locked.js';
import { makeCtx, cleanReport, fixture } from '../../helpers/filter-ctx.js';
import type { RugcheckReport } from '../../../src/clients/rugcheck.js';

describe('lpLocked filter', () => {
  it('verifies a burned PumpSwap LP on-chain (LP supply 0)', async () => {
    const { ctx, calls } = makeCtx({ lpSupply: 0n });
    const r = await lpLockedFilter.check(ctx);
    expect(r).toMatchObject({ status: 'pass', data: { source: 'onchain', matchedDexScreenerPair: true, marketType: 'pump_fun_amm' } });
    expect(calls).toContain('getTokenSupply');
  });

  it("uses RugCheck's locked % when LP supply is non-zero", async () => {
    const r = await lpLockedFilter.check(makeCtx({ lpSupply: 123n }).ctx);
    expect(r).toMatchObject({ status: 'pass', data: { source: 'rugcheck' } });
  });

  it('fails when the LP is mostly unlocked', async () => {
    const report = cleanReport();
    report.markets![0]!.lp!.lpLockedPct = 40;
    const r = await lpLockedFilter.check(makeCtx({ report, lpSupply: 1_000n }).ctx);
    expect(r.status).toBe('fail');
    expect(r.reason).toMatch(/LP only 40\.0%/);
  });

  it('fails a position-based primary pool without locks (real Meteora DLMM report)', async () => {
    const report = fixture<RugcheckReport>('rugcheck-report-lp-unlocked-transferfee.json');
    const r = await lpLockedFilter.check(makeCtx({ report, candidate: { primaryPair: { address: 'unmatched', dexId: 'raydium', quoteMint: '', liquidityUsd: 1, labels: [] } } }).ctx);
    expect(r.status).toBe('fail');
    expect(r.reason).toMatch(/meteoraDlmm \(position-based/);
  });

  it('is missing without RugCheck market data', async () => {
    expect((await lpLockedFilter.check(makeCtx({ report: null }).ctx)).status).toBe('missing');
    expect((await lpLockedFilter.check(makeCtx({ report: { ...cleanReport(), markets: [] } }).ctx)).status).toBe('missing');
  });
});
