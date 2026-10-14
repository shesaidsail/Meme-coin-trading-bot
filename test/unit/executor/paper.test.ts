import { describe, it, expect } from 'vitest';
import { PaperExecutor } from '../../../src/executor/paper.js';
import { testConfig } from '../../helpers/deps.js';
import { FakeJupiter, priced, noRoute } from '../../helpers/fake-jupiter.js';
import { SOL } from '../../helpers/filter-ctx.js';

function exec(fn: ConstructorParameters<typeof FakeJupiter>[0], config = testConfig()) {
  const jupiter = new FakeJupiter(fn);
  const sleeps: number[] = [];
  const ex = new PaperExecutor({ jupiter, config, sleep: async (ms) => void sleeps.push(ms) });
  return { ex, jupiter, sleeps, config };
}

describe('PaperExecutor', () => {
  it('fills at the execution quote (taken after the latency) minus adverse fill, using real quotes', async () => {
    const { ex, jupiter, sleeps } = exec((req, n) => priced(req, n === 0 ? 1000 : 990));
    const r = await ex.buy('MINT', { amount: 1_000_000n, slippageBps: 300 });
    expect(sleeps).toEqual([1500]);
    expect(jupiter.requests.map((q) => [q.inputMint, q.outputMint])).toEqual([
      [SOL, 'MINT'],
      [SOL, 'MINT'],
    ]);
    // 990 per lamport, minus 50bps adverse.
    expect(r).toMatchObject({ status: 'filled', inFilled: 1_000_000n, out: 985_050_000n, quotedOut: 1_000_000_000n, feeLamports: 100_000n });
  });

  it('fails with slippage when the price moves beyond tolerance, and still pays the fee', async () => {
    const { ex } = exec((req, n) => priced(req, n === 0 ? 1000 : 960));
    const r = await ex.buy('MINT', { amount: 1_000_000n, slippageBps: 300 });
    expect(r).toMatchObject({ status: 'failed', failure: 'slippage', inFilled: 0n, out: 0n, feeLamports: 100_000n });
  });

  it('fails without a fee when there is no route at decision time', async () => {
    const { ex, jupiter } = exec(() => noRoute);
    const r = await ex.sell('MINT', { amount: 5n, slippageBps: 300 });
    expect(r).toMatchObject({ status: 'failed', failure: 'no_route', feeLamports: 0n });
    expect(jupiter.requests).toHaveLength(1);
    expect(jupiter.requests[0]!.priority).toBe('critical');
  });

  it('does not treat high price impact as a failure (it is already in the quote)', async () => {
    const { ex } = exec((req) => priced(req, 1, 0.4));
    expect((await ex.sell('MINT', { amount: 1_000n, slippageBps: 300 })).status).toBe('filled');
  });

  it('treats a route vanishing after the decision as a failed transaction that paid its fee', async () => {
    const { ex } = exec((req, n) => (n === 0 ? priced(req, 1) : noRoute));
    expect(await ex.sell('MINT', { amount: 1_000n, slippageBps: 300 })).toMatchObject({ status: 'failed', failure: 'no_route', feeLamports: 100_000n });
  });
});
