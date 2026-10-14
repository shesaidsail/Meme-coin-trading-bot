import { describe, it, expect } from 'vitest';
import { tokenAgeFilter } from '../../../src/filters/token-age.js';
import { makeCtx, cleanReport } from '../../helpers/filter-ctx.js';
import { NOW } from '../../helpers/deps.js';

describe('tokenAge filter', () => {
  it('passes on pair age alone without calling RugCheck', async () => {
    const { ctx, calls } = makeCtx({ candidate: { earliestPairCreatedAt: NOW - 45 * 60_000 } });
    const r = await tokenAgeFilter.check(ctx);
    expect(r).toMatchObject({ status: 'pass', data: { ageMinutes: 45 } });
    expect(calls).not.toContain('rugcheck');
  });

  it('uses RugCheck detection time when the pair is younger than the token', async () => {
    const report = { ...cleanReport(), detectedAt: new Date(NOW - 3 * 3_600_000).toISOString() };
    const r = await tokenAgeFilter.check(makeCtx({ candidate: { earliestPairCreatedAt: NOW - 5 * 60_000 }, report }).ctx);
    expect(r).toMatchObject({ status: 'pass', data: { ageMinutes: 180 } });
  });

  it('fails a token younger than the minimum', async () => {
    const report = { ...cleanReport(), detectedAt: new Date(NOW - 10 * 60_000).toISOString() };
    const r = await tokenAgeFilter.check(makeCtx({ candidate: { earliestPairCreatedAt: NOW - 10 * 60_000 }, report }).ctx);
    expect(r.status).toBe('fail');
    expect(r.reason).toMatch(/age 10m < 30m/);
  });

  it('is missing when no timestamp is available', async () => {
    const r = await tokenAgeFilter.check(makeCtx({ candidate: { earliestPairCreatedAt: null }, report: null }).ctx);
    expect(r.status).toBe('missing');
  });
});
