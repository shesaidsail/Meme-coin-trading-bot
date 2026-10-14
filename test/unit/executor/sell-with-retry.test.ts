import { describe, it, expect } from 'vitest';
import { sellWithRetry } from '../../../src/executor/sell-with-retry.js';
import type { Executor, SwapRequest, SwapResult } from '../../../src/executor/types.js';
import { makeDeps } from '../../helpers/deps.js';
import { newPosition, buyFill } from '../../helpers/storage.js';
import { solToLamports } from '../../../src/util/units.js';

/** Executor driven by a script of outcomes; fills at 1 lamport per token. */
class ScriptedExecutor implements Executor {
  readonly mode = 'paper' as const;
  readonly requests: SwapRequest[] = [];
  constructor(private readonly script: ((req: SwapRequest) => SwapResult)[]) {}
  async buy(): Promise<SwapResult> {
    throw new Error('unused');
  }
  async sell(_mint: string, req: SwapRequest): Promise<SwapResult> {
    this.requests.push(req);
    const f = this.script[Math.min(this.requests.length - 1, this.script.length - 1)]!;
    return f(req);
  }
}
const fill = (req: SwapRequest): SwapResult => ({ status: 'filled', inFilled: req.amount, out: req.amount, quotedOut: req.amount, priceImpact: 0.01, feeLamports: 100_000n, signature: null });
const slip = (): SwapResult => ({ status: 'failed', failure: 'slippage', error: 'slippage', inFilled: 0n, out: 0n, quotedOut: null, priceImpact: null, feeLamports: 100_000n, signature: null });
const noRoute = (): SwapResult => ({ status: 'failed', failure: 'no_route', error: 'no route', inFilled: 0n, out: 0n, quotedOut: null, priceImpact: null, feeLamports: 0n, signature: null });

function setup(script: ((req: SwapRequest) => SwapResult)[], tokens = 1_000_000_000n) {
  const d = makeDeps();
  const { positionId } = d.storage.openPosition(newPosition(d.clock, { tokenAmountRaw: tokens, costBasisLamports: solToLamports(0.5) }), buyFill());
  const executor = new ScriptedExecutor(script);
  const sleeps: number[] = [];
  const run = () =>
    sellWithRetry(d.storage.positions.get(positionId)!, 'time_stop', { executor, storage: d.storage, config: d.config, clock: d.clock, logger: d.logger, solUsd: 150, sleep: async (ms) => void sleeps.push(ms) });
  return { ...d, positionId, executor, sleeps, run };
}

describe('sellWithRetry', () => {
  it('sells the full position in one attempt and closes with the rent refund', async () => {
    const { run, storage, positionId, config } = setup([fill]);
    const r = await run();
    expect(r).toMatchObject({ closed: true, attempts: 1 });
    const p = storage.positions.get(positionId)!;
    expect(p).toMatchObject({ status: 'closed', exitReason: 'time_stop', tokenAmountRaw: 0n });
    expect(p.realizedLamports).toBe(1_000_000_000n - 100_000n + BigInt(config.costs.ataRentLamports));
  });

  it('escalates slippage on each slippage failure, up to the cap, logging every attempt', async () => {
    const { run, executor, storage, positionId, sleeps } = setup([slip, slip, slip, slip, slip, slip, slip, fill], 1_000n);
    const r = await run();
    // initial 300, +300 each time, capped at 2000; maxAttempts 6.
    expect(executor.requests.map((q) => q.slippageBps)).toEqual([300, 600, 900, 1200, 1500, 1800]);
    expect(r.closed).toBe(false);
    expect(storage.trades.listByPosition(positionId).filter((t) => t.side === 'sell')).toHaveLength(6);
    expect(storage.audit.list({ event: 'sell_failed' })).toHaveLength(6);
    expect(storage.audit.list({ event: 'sell_incomplete' })).toHaveLength(1);
    expect(sleeps).toHaveLength(5);
    // Failed attempts still paid their fees.
    expect(storage.positions.get(positionId)!.realizedLamports).toBe(-600_000n);
  });

  it('caps slippage at the configured maximum', async () => {
    const { run, executor, config } = setup(Array(6).fill(slip));
    config.execution.sell.initialSlippageBps = 1500;
    await run();
    expect(executor.requests.map((q) => q.slippageBps)).toEqual([1500, 1800, 2000, 2000, 2000, 2000]);
  });

  it('halves the size after a no-route failure and completes through partial fills', async () => {
    const { run, executor, storage, positionId } = setup([noRoute, fill, fill]);
    const r = await run();
    expect(executor.requests.map((q) => q.amount)).toEqual([1_000_000_000n, 500_000_000n, 500_000_000n]);
    expect(r).toMatchObject({ closed: true, attempts: 3 });
    expect(storage.trades.listByPosition(positionId).filter((t) => t.side === 'sell').map((t) => t.status)).toEqual(['failed', 'partial', 'filled']);
  });

  it('leaves a partially sold position open when attempts run out', async () => {
    const { run, storage, positionId } = setup([noRoute, fill, noRoute, noRoute, noRoute, noRoute]);
    const r = await run();
    expect(r.closed).toBe(false);
    const p = storage.positions.get(positionId)!;
    expect(p.status).toBe('open');
    expect(p.tokenAmountRaw).toBe(500_000_000n);
  });

  it('writes off dust and closes', async () => {
    const leaveDust = (req: SwapRequest): SwapResult => ({ ...fill(req), inFilled: req.amount - 500_000n });
    const { run, storage, positionId } = setup([leaveDust]);
    expect((await run()).closed).toBe(true);
    expect(storage.positions.get(positionId)!.tokenAmountRaw).toBe(500_000n);
  });
});
