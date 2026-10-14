import { describe, it, expect } from 'vitest';
import { devWalletFilter } from '../../../src/filters/dev-wallet.js';
import { makeCtx, cleanReport } from '../../helpers/filter-ctx.js';
import { launchTxs, part, SUPPLY } from './launch.fixtures.js';

const CREATOR = cleanReport().creator!;

describe('devWallet filter', () => {
  it('passes the real ABU creator (holds ~0.01%), with sell history unknown', async () => {
    const r = await devWalletFilter.check(makeCtx().ctx);
    expect(r).toMatchObject({ status: 'pass', data: { soldFraction: 'unknown' } });
  });

  it('fails when the creator holds too much', async () => {
    const r = await devWalletFilter.check(makeCtx({ report: { ...cleanReport(), creatorBalance: Number(part(0.08)) } }).ctx);
    expect(r.reason).toMatch(/creator holds 8\.0%/);
  });

  it('fails on RugCheck creator-rug risks when enabled', async () => {
    const report = { ...cleanReport(), risks: [{ name: 'Creator history of rugged tokens', level: 'danger', score: 1 }] };
    expect((await devWalletFilter.check(makeCtx({ report }).ctx)).status).toBe('fail');
    const off = await devWalletFilter.check(makeCtx({ report, config: { filters: { devWallet: { rejectPriorRugs: false } } } }).ctx);
    expect(off.status).toBe('pass');
  });

  it('detects heavy selling when the launch buy is known on-chain', async () => {
    const { signatures, txs } = launchTxs(CREATOR);
    // Creator bought 4% at launch and now holds 1% → sold 75%.
    const report = { ...cleanReport(), creatorBalance: Number(part(0.01)) };
    const r = await devWalletFilter.check(makeCtx({ report, signatures, txs }).ctx);
    expect(r.status).toBe('fail');
    expect(r.reason).toMatch(/creator sold 75\.0% of launch buy/);
  });

  it('passes a creator still holding the launch buy', async () => {
    const { signatures, txs } = launchTxs(CREATOR);
    const report = { ...cleanReport(), creatorBalance: Number(part(0.04)) };
    const r = await devWalletFilter.check(makeCtx({ report, signatures, txs }).ctx);
    expect(r).toMatchObject({ status: 'pass', data: { soldFraction: 0 } });
    expect(SUPPLY > 0n).toBe(true);
  });

  it('is missing without a creator', async () => {
    expect((await devWalletFilter.check(makeCtx({ report: { ...cleanReport(), creator: null } }).ctx)).status).toBe('missing');
    expect((await devWalletFilter.check(makeCtx({ report: null }).ctx)).status).toBe('missing');
  });
});
