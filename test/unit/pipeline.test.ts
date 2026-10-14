import { describe, it, expect } from 'vitest';
import { runPipeline, toOutcome } from '../../src/filters/pipeline.js';
import { ALL_FILTERS } from '../../src/filters/index.js';
import type { Filter } from '../../src/filters/types.js';
import { pass, fail, missing } from '../../src/filters/types.js';
import { BudgetExhaustedError } from '../../src/clients/errors.js';
import { makeCtx } from '../helpers/filter-ctx.js';

const stub = (name: Filter['name'], r: Awaited<ReturnType<Filter['check']>> | Error): Filter => ({
  name,
  check: async () => {
    if (r instanceof Error) throw r;
    return r;
  },
});

describe('missing-data policy', () => {
  it('maps per policy and keeps insufficient data distinct from failures', () => {
    expect(toOutcome(pass(), 'reject')).toEqual({ outcome: 'pass', rejects: false });
    expect(toOutcome(fail('x'), 'skip')).toEqual({ outcome: 'fail', rejects: true });
    expect(toOutcome(missing('x'), 'reject')).toEqual({ outcome: 'insufficient_data', rejects: true });
    expect(toOutcome(missing('x'), 'skip')).toEqual({ outcome: 'skipped', rejects: false });
    expect(toOutcome(missing('x'), 'warn')).toEqual({ outcome: 'warn', rejects: false });
  });
});

describe('runPipeline', () => {
  const filters = [stub('liquidity', pass()), stub('tokenAge', missing('no ts')), stub('mintAuthority', fail('set')), stub('freezeAuthority', pass())];

  it('stops at the first reject by default, recording which filter rejected', async () => {
    const r = await runPipeline(makeCtx().ctx, filters, { stopOnFirstReject: true });
    expect(r.verdict).toBe('rejected');
    expect(r.rejectedBy).toEqual(['tokenAge']);
    expect(r.results.map((x) => [x.filter, x.outcome])).toEqual([
      ['liquidity', 'pass'],
      ['tokenAge', 'insufficient_data'],
    ]);
  });

  it('runs everything when asked, applying per-filter policies', async () => {
    const { ctx } = makeCtx({ config: { filters: { tokenAge: { onMissingData: 'warn' } } } });
    const r = await runPipeline(ctx, filters, { stopOnFirstReject: false });
    expect(r.rejectedBy).toEqual(['mintAuthority']);
    expect(r.results.map((x) => x.outcome)).toEqual(['pass', 'warn', 'fail', 'pass']);
  });

  it('skips disabled filters entirely', async () => {
    const { ctx } = makeCtx({ config: { filters: { mintAuthority: { enabled: false }, tokenAge: { onMissingData: 'skip' } } } });
    const r = await runPipeline(ctx, filters, { stopOnFirstReject: true });
    expect(r.verdict).toBe('passed');
    expect(r.results.map((x) => x.filter)).toEqual(['liquidity', 'tokenAge', 'freezeAuthority']);
  });

  it('turns an unexpected filter exception into missing data', async () => {
    const r = await runPipeline(makeCtx().ctx, [stub('liquidity', new TypeError('boom'))], { stopOnFirstReject: true });
    expect(r.results[0]).toMatchObject({ outcome: 'insufficient_data', reason: 'filter error: boom' });
  });

  it('propagates budget exhaustion so the scan stops', async () => {
    await expect(runPipeline(makeCtx().ctx, [stub('liquidity', new BudgetExhaustedError('rpc', 'out'))], { stopOnFirstReject: true })).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
  });

  it('passes the real ABU data through every filter (public-RPC conditions)', async () => {
    const r = await runPipeline(makeCtx().ctx, ALL_FILTERS, { stopOnFirstReject: false });
    expect(r.results.map((x) => [x.filter, x.outcome])).toEqual(ALL_FILTERS.map((f) => [f.name, 'pass']));
  });

  it('orders filters cheapest-first: a liquidity failure makes no API calls', async () => {
    const { ctx, calls } = makeCtx({ candidate: { primaryPair: { address: 'p', dexId: 'pumpswap', quoteMint: '', liquidityUsd: 1_000, labels: [] } } });
    const r = await runPipeline(ctx, ALL_FILTERS, { stopOnFirstReject: true });
    expect(r.rejectedBy).toEqual(['liquidity']);
    expect(calls).toEqual([]);
  });

  it('every configured filter has an implementation', () => {
    const { config } = makeCtx();
    expect(ALL_FILTERS.map((f) => f.name).sort()).toEqual(Object.keys(config.filters).sort());
  });
});
