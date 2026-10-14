import { describe, it, expect } from 'vitest';
import { rugcheckScoreFilter } from '../../../src/filters/rugcheck-score.js';
import { makeCtx, cleanReport, fixture } from '../../helpers/filter-ctx.js';
import type { RugcheckReport } from '../../../src/clients/rugcheck.js';

describe('rugcheckScore filter', () => {
  it('passes a low risk score (real report, score 1)', async () => {
    expect((await rugcheckScoreFilter.check(makeCtx().ctx)).status).toBe('pass');
  });

  it('rejects a high RISK score (higher = riskier, verified on live data)', async () => {
    const report = fixture<RugcheckReport>('rugcheck-report-lp-unlocked-transferfee.json');
    const r = await rugcheckScoreFilter.check(makeCtx({ report }).ctx);
    expect(r.status).toBe('fail');
    expect(r.reason).toMatch(/risk score 51 > 30/);
  });

  it('rejects danger-level risks even under the score threshold', async () => {
    const report = { ...cleanReport(), score_normalised: 5, risks: [{ name: 'Large Amount of LP Unlocked', level: 'danger', score: 1 }] };
    const r = await rugcheckScoreFilter.check(makeCtx({ report }).ctx);
    expect(r.reason).toMatch(/danger risk/);
    const off = await rugcheckScoreFilter.check(makeCtx({ report, config: { filters: { rugcheckScore: { rejectOnDangerRisks: false } } } }).ctx);
    expect(off.status).toBe('pass');
  });

  it('rejects tokens marked rugged', async () => {
    const r = await rugcheckScoreFilter.check(makeCtx({ report: { ...cleanReport(), rugged: true } }).ctx);
    expect(r.reason).toMatch(/rugged/);
  });

  it('is missing without a report or a score', async () => {
    expect((await rugcheckScoreFilter.check(makeCtx({ report: null }).ctx)).status).toBe('missing');
    expect((await rugcheckScoreFilter.check(makeCtx({ report: { ...cleanReport(), score_normalised: null } }).ctx)).status).toBe('missing');
  });
});
