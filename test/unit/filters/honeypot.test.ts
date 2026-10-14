import { describe, it, expect } from 'vitest';
import { honeypotFilter } from '../../../src/filters/honeypot.js';
import { makeCtx, quote, ABU_MINT, SOL } from '../../helpers/filter-ctx.js';

const SIZE = 500_000_000n;

describe('honeypot filter', () => {
  it('passes a normal round trip (~2.7% loss, low sell impact)', async () => {
    const { ctx, calls } = makeCtx();
    const r = await honeypotFilter.check(ctx);
    expect(r.status).toBe('pass');
    expect(r.data!.roundTripLoss as number).toBeCloseTo(0.027, 3);
    expect(calls).toEqual(['quote:buy', 'quote:sell']);
  });

  it('quotes the buy at our entry size and sells exactly what the buy returns', async () => {
    const { ctx, quoteRequests } = makeCtx({ sizeLamports: SIZE, buy: quote(SOL, ABU_MINT, SIZE, 777n) });
    await honeypotFilter.check(ctx);
    expect(quoteRequests).toEqual([
      { inputMint: SOL, outputMint: ABU_MINT, amount: SIZE },
      { inputMint: ABU_MINT, outputMint: SOL, amount: 777n },
    ]);
  });

  it('fails when the sell has no route (honeypot)', async () => {
    const r = await honeypotFilter.check(makeCtx({ sell: { ok: false, reason: 'no_route', message: 'Could not find any route' } }).ctx);
    expect(r.status).toBe('fail');
    expect(r.reason).toMatch(/sell quote failed.*possible honeypot/);
  });

  it('fails when the token cannot be bought', async () => {
    const r = await honeypotFilter.check(makeCtx({ buy: { ok: false, reason: 'not_tradable', message: 'not tradable' } }).ctx);
    expect(r.reason).toMatch(/no buy route/);
  });

  it('fails on a large round-trip loss (hidden sell tax)', async () => {
    const r = await honeypotFilter.check(makeCtx({ sell: quote(ABU_MINT, SOL, 1n, (SIZE * 70n) / 100n, 0.01) }).ctx);
    expect(r.reason).toMatch(/round-trip loss 30\.0% > 15\.0%/);
  });

  it('fails on high sell price impact', async () => {
    const r = await honeypotFilter.check(makeCtx({ sell: quote(ABU_MINT, SOL, 1n, (SIZE * 95n) / 100n, 0.2) }).ctx);
    expect(r.reason).toMatch(/sell price impact 20\.0%/);
  });

  it('is missing when Jupiter is unreachable', async () => {
    expect((await honeypotFilter.check(makeCtx({ buy: new Error('jupiter: timeout') }).ctx)).status).toBe('missing');
  });
});
