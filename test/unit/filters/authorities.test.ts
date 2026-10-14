import { describe, it, expect } from 'vitest';
import { mintAuthorityFilter, freezeAuthorityFilter } from '../../../src/filters/authorities.js';
import { makeCtx, abuMintInfo, cleanReport } from '../../helpers/filter-ctx.js';

describe.each([
  ['mintAuthority', mintAuthorityFilter],
  ['freezeAuthority', freezeAuthorityFilter],
] as const)('%s filter', (field, filter) => {
  it('passes when revoked on-chain', async () => {
    const r = await filter.check(makeCtx().ctx);
    expect(r).toMatchObject({ status: 'pass', data: { source: 'onchain' } });
  });

  it('fails when still set on-chain, even if RugCheck says revoked', async () => {
    const r = await filter.check(makeCtx({ mint: { ...abuMintInfo(), [field]: 'Auth111' } }).ctx);
    expect(r.status).toBe('fail');
    expect(r.reason).toContain('Auth111');
  });

  it('falls back to RugCheck when the RPC fails', async () => {
    const { ctx } = makeCtx({ mint: new Error('rpc down'), report: { ...cleanReport(), [field]: 'RcAuth' } });
    const r = await filter.check(ctx);
    expect(r).toMatchObject({ status: 'fail', data: { source: 'rugcheck' } });
  });

  it('is missing when neither source is available', async () => {
    const r = await filter.check(makeCtx({ mint: new Error('rpc down'), report: new Error('rc down') }).ctx);
    expect(r.status).toBe('missing');
    expect(r.reason).toMatch(/rpc down.*rc down/);
  });
});
