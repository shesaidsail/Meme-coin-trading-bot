import { describe, it, expect } from 'vitest';
import { bundledLaunchFilter } from '../../../src/filters/bundled-launch.js';
import { makeCtx, cleanReport, abuMintInfo } from '../../helpers/filter-ctx.js';
import { launchTxs } from './launch.fixtures.js';

const supply = Number(abuMintInfo().supply);

describe('bundledLaunch filter', () => {
  it('passes the real ABU report (insiders ~0%, linked network ~3.8%) when history is too long', async () => {
    const r = await bundledLaunchFilter.check(makeCtx().ctx);
    expect(r.status).toBe('pass');
    expect(r.data!.linkedNetworkFraction as number).toBeCloseTo(0.0375, 3);
    expect(r.data!.onchain).toMatch(/history longer than 3000/);
  });

  it('fails when insider-flagged holders hold too much', async () => {
    const report = cleanReport();
    report.topHolders = [{ address: 'a', owner: 'o', amount: 1, pct: 20, insider: true }];
    const r = await bundledLaunchFilter.check(makeCtx({ report }).ctx);
    expect(r.reason).toMatch(/insider-flagged holders hold 20\.0%/);
  });

  it('fails when a linked-wallet network moved most of the supply (live YILONGMA pattern)', async () => {
    const report = { ...cleanReport(), insiderNetworks: [{ id: 'n', size: 32, type: 'transfer', tokenAmount: supply * 0.989, currentHolding: supply * 0.989, activeAccounts: 32 }] };
    const r = await bundledLaunchFilter.check(makeCtx({ report }).ctx);
    expect(r.status).toBe('fail');
    expect(r.reason).toMatch(/98\.9% of supply moved through a network of 32 linked wallets/);
  });

  it('fails on heavy launch-slot buying found on-chain', async () => {
    const { signatures, txs } = launchTxs('Dev');
    const r = await bundledLaunchFilter.check(makeCtx({ signatures, txs, config: { filters: { bundledLaunch: { maxLaunchBuyFraction: 0.15 } } } }).ctx);
    expect(r.status).toBe('fail');
    expect(r.reason).toMatch(/22\.0% of supply bought in first 2 slot\(s\) by 3 wallet\(s\)/);
  });

  it('walks back through history pages until the launch', async () => {
    const { signatures, txs } = launchTxs('Dev');
    const fullPage = Array.from({ length: 1000 }, (_, i) => ({ signature: `x${i}`, slot: 10_000 - i, blockTime: null, err: null }));
    const { ctx, calls } = makeCtx({ signatures: [fullPage, ...signatures], txs });
    const r = await bundledLaunchFilter.check(ctx);
    expect(calls.filter((c) => c === 'getSignaturesForAddress')).toHaveLength(2);
    expect(r.data!.launchBuyFraction as number).toBeCloseTo(0.22, 3);
  });

  it('uses only on-chain data when RugCheck is down', async () => {
    const { signatures, txs } = launchTxs('Dev');
    const r = await bundledLaunchFilter.check(makeCtx({ report: new Error('rc down'), signatures, txs }).ctx);
    expect(r.status).toBe('fail'); // 22% > 20% default
  });

  it('is missing when neither source is available', async () => {
    const r = await bundledLaunchFilter.check(makeCtx({ report: new Error('rc down') }).ctx);
    expect(r.status).toBe('missing');
  });
});
