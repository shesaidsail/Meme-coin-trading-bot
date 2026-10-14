import { describe, it, expect } from 'vitest';
import { holderCountFilter } from '../../../src/filters/holder-count.js';
import { makeCtx, cleanReport } from '../../helpers/filter-ctx.js';

describe('holderCount filter', () => {
  it('passes with enough holders (real: 6572)', async () => {
    expect(await holderCountFilter.check(makeCtx().ctx)).toMatchObject({ status: 'pass', data: { holders: 6572 } });
  });
  it('fails below the minimum', async () => {
    const r = await holderCountFilter.check(makeCtx({ report: { ...cleanReport(), totalHolders: 150 } }).ctx);
    expect(r.reason).toBe('150 holders < 200');
  });
  it('is missing without a count', async () => {
    expect((await holderCountFilter.check(makeCtx({ report: { ...cleanReport(), totalHolders: null } }).ctx)).status).toBe('missing');
  });
});
