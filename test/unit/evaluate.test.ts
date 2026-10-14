import { describe, it, expect } from 'vitest';
import { evaluateCandidates } from '../../src/engine/evaluate.js';
import { ALL_FILTERS } from '../../src/filters/index.js';
import { makeDeps } from '../helpers/deps.js';
import { rpcOk } from '../helpers/fake-fetch.js';
import { fixture, abuCandidate } from '../helpers/filter-ctx.js';

/** Full stack over fake HTTP: real clients, real filters, real storage. */
function routes(d: ReturnType<typeof makeDeps>, opts: { report?: unknown } = {}) {
  const sell = { ...fixture<Record<string, unknown>>('jupiter-quote-buy.json'), outAmount: '486000000', otherAmountThreshold: '470000000', priceImpactPct: '0.002' };
  d.fake
    .on(/getAccountInfo/, { body: fixture('rpc-mint-token2022.json') })
    .on(/getTokenLargestAccounts/, { status: 429, headers: { 'retry-after': '10', 'x-ratelimit-method-limit': '0' } })
    .on(/getTokenSupply/, rpcOk({ value: { amount: '0' } }))
    .on(/getSignaturesForAddress/, rpcOk(Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, slot: 5000 - i, err: null }))))
    .on(/report/, { body: opts.report ?? fixture('rugcheck-report-pumpswap-clean.json'), headers: { 'x-rate-limit-limit': '15', 'x-rate-limit-remaining': '14' } })
    .on(/quote\?inputMint=So111/, { body: fixture('jupiter-quote-buy.json') })
    .on(/quote\?/, { body: sell });
}

describe('evaluateCandidates (full stack, fake HTTP)', () => {
  it('passes a clean token, records every filter result, and falls back from the blocked RPC method', async () => {
    const d = makeDeps();
    routes(d);
    const { evaluations, budgetExhausted } = await evaluateCandidates([abuCandidate()], 'scan1', 500_000_000n, { ...d, filters: ALL_FILTERS }, { stopOnFirstReject: false });
    expect(budgetExhausted).toBeNull();
    expect(evaluations[0]!.result.verdict).toBe('passed');
    const counts = d.storage.audit.filterOutcomeCounts();
    expect(Object.values(counts).every((c) => c.pass === 1)).toBe(true);
    // getTokenLargestAccounts tried once (no retries), then RugCheck holders were used.
    expect(d.fake.count(/getTokenLargestAccounts/)).toBe(1);
    expect(evaluations[0]!.result.results.find((r) => r.filter === 'holderConcentration')!.data).toMatchObject({ source: 'rugcheck' });
    // RugCheck fetched once despite being used by many filters.
    expect(d.fake.count(/report/)).toBe(1);
  });

  it('records a rejection with the rejecting filter', async () => {
    const d = makeDeps();
    routes(d, { report: fixture('rugcheck-report-lp-unlocked-transferfee.json') });
    const { evaluations } = await evaluateCandidates([abuCandidate()], 'scan1', 500_000_000n, { ...d, filters: ALL_FILTERS });
    expect(evaluations[0]!.result.rejectedBy).toEqual(['rugcheckScore']);
    expect(d.storage.audit.evaluationCounts()).toEqual({ passed: 0, rejected: 1 });
  });

  it('stops cleanly when a budget runs out, without recording a bogus data gap', async () => {
    const d = makeDeps({ config: { apis: { rugcheck: { budget: { unitsPerDay: 1, reserveFraction: 0.5 } } } } });
    routes(d);
    const { evaluations, budgetExhausted } = await evaluateCandidates([abuCandidate(), abuCandidate()], 's', 500_000_000n, { ...d, filters: ALL_FILTERS });
    expect(evaluations).toHaveLength(0);
    expect(budgetExhausted).toMatch(/daily budget exhausted/);
    expect(d.storage.audit.filterOutcomeCounts()).toEqual({});
    expect(d.storage.audit.list({ event: 'budget_exhausted' })).toHaveLength(1);
  });
});
