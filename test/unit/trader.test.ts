import { describe, it, expect } from 'vitest';
import { Trader } from '../../src/engine/trader.js';
import { PaperExecutor } from '../../src/executor/paper.js';
import { LiveExecutor } from '../../src/executor/live.js';
import { computeEquity, valuePositions } from '../../src/risk/equity.js';
import { Storage } from '../../src/storage/store.js';
import { makeDeps } from '../helpers/deps.js';
import { FakeJupiter, priced } from '../helpers/fake-jupiter.js';
import { abuCandidate, SOL } from '../helpers/filter-ctx.js';
import { tempDb } from '../helpers/storage.js';
import { HOUR_MS } from '../../src/util/clock.js';
import { solToLamports } from '../../src/util/units.js';

/** 1 lamport buys 1000 tokens; selling returns 1/1000 lamport per token (2% impact each way). */
function market() {
  let priceMultiple = 1;
  const jupiter = new FakeJupiter((req) => (req.inputMint === SOL ? priced(req, 1000, 0.02) : priced(req, priceMultiple / 1000, 0.02)));
  return { jupiter, setPrice: (m: number) => (priceMultiple = m) };
}

function setup(path?: string) {
  const d = makeDeps();
  const storage = path ? Storage.open({ path, mode: 'paper', clock: d.clock }) : d.storage;
  if (path) storage.ledger.initialise(solToLamports(10), d.clock.now());
  const { jupiter, setPrice } = market();
  const executor = new PaperExecutor({ jupiter, config: d.config, sleep: async () => undefined });
  const trader = new Trader({ config: d.config, executor, jupiter, storage, clock: d.clock, logger: d.logger, sleep: async () => undefined });
  const equity = async () => {
    const open = storage.positions.listOpen();
    return computeEquity(storage.ledger.balance(), open, await valuePositions(open, { jupiter, storage, config: d.config, clock: d.clock, logger: d.logger }));
  };
  return { ...d, storage, jupiter, setPrice, trader, equity };
}

describe('Trader.enter (paper)', () => {
  it('commits exactly 5% of equity, records costs, the take-profit target and the 48h deadline', async () => {
    const { trader, storage, clock, equity } = setup();
    const r = await trader.enter(abuCandidate(), await equity(), { solUsd: 150, tokenDecimals: 6 });
    if (!r.entered) throw new Error(r.detail);
    const p = storage.positions.get(r.positionId)!;
    expect(p.costBasisLamports).toBe(solToLamports(0.5));
    expect(storage.ledger.balance()).toBe(solToLamports(9.5));
    expect(p.tpTargetNetLamports).toBe(solToLamports(1.25));
    expect(p.timeStopAt - p.enteredAt).toBe(48 * HOUR_MS);
    expect(p.enteredAt).toBe(clock.now());
    expect(p.tokenDecimals).toBe(6);
    expect(p.entrySolUsd).toBe(150);
    // Buy cost ≈ 2% impact + 0.5% adverse fill + priority fee; sell ≈ 2% impact + 1% expected slippage + fee.
    expect(p.buyCostFraction).toBeGreaterThan(0.024);
    expect(p.buyCostFraction).toBeLessThan(0.03);
    expect(p.sellCostFraction).toBeCloseTo(0.0302, 3);
    expect(p.tpGrossMultiplier).toBeCloseTo(2.5 / ((1 - p.buyCostFraction) * (1 - p.sellCostFraction)), 10);
  });

  it('stops at 10 open positions and at 50% deployed', async () => {
    const { trader, equity } = setup();
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await trader.enter(abuCandidate({ mint: `M${i}` }), await equity(), { solUsd: null, tokenDecimals: 6 }));
    const entered = results.filter((r) => r.entered).length;
    // Positions mark below cost after entry costs, so 10 entries fit under 50%; the 11th hits the count cap.
    expect(entered).toBe(10);
    expect(results[10]).toMatchObject({ entered: false, reason: 'max_open_positions' });
  });

  it('refuses new entries once appreciated positions push deployed capital to the 50% cap', async () => {
    const { trader, equity, setPrice } = setup();
    for (let i = 0; i < 5; i++) await trader.enter(abuCandidate({ mint: `M${i}` }), await equity(), { solUsd: null, tokenDecimals: 6 });
    // Positions triple: deployed ≈ 5 × 0.5 × 3 × costs ≈ 7 SOL vs equity ≈ 14.5 SOL → over 45%.
    setPrice(3);
    const e = await equity();
    expect(Number(e.deployedLamports) / Number(e.equityLamports)).toBeGreaterThan(0.45);
    const r = await trader.enter(abuCandidate({ mint: 'next' }), e, { solUsd: null, tokenDecimals: 6 });
    expect(r).toMatchObject({ entered: false, reason: 'max_deployed' });
  });

  it('records a failed buy without opening a position', async () => {
    const d = setup();
    d.jupiter.fn = (req, n) => priced(req, n % 2 === 0 ? 1000 : 900); // execution price 10% worse than decision
    const r = await d.trader.enter(abuCandidate(), await d.equity(), { solUsd: null, tokenDecimals: 6 });
    expect(r).toMatchObject({ entered: false, reason: 'buy_slippage' });
    expect(d.storage.positions.countOpen()).toBe(0);
    expect(d.storage.audit.list({ event: 'buy_failed' })).toHaveLength(1);
  });
});

describe('Trader.exit (paper)', () => {
  it('realises a 2.6x move as roughly +150% net after all costs', async () => {
    const { trader, storage, setPrice, equity } = setup();
    const r = await trader.enter(abuCandidate(), await equity(), { solUsd: 150, tokenDecimals: 6 });
    if (!r.entered) throw new Error('no entry');
    setPrice(r.tpGrossMultiplier);
    const out = await trader.exit(storage.positions.get(r.positionId)!, 'take_profit', 160);
    expect(out.closed).toBe(true);
    const p = storage.positions.get(r.positionId)!;
    const netMultiple = Number(p.realizedLamports) / Number(p.costBasisLamports);
    // The gross trigger is calibrated for +150% net. Small differences: actual sell
    // slippage here is the 0.5% adverse fill vs. 1% expected, plus the rent refund.
    expect(netMultiple).toBeGreaterThan(2.5);
    expect(netMultiple).toBeLessThan(2.53);
    expect(p).toMatchObject({ exitReason: 'take_profit', exitSolUsd: 160 });
  });
});

describe('48h time stop across restarts (via Trader)', () => {
  it('keeps the original deadline after a restart and reports it due once 48h have passed', async () => {
    const db = tempDb();
    try {
      const a = setup(db.path);
      const r = await a.trader.enter(abuCandidate(), await a.equity(), { solUsd: null, tokenDecimals: 6 });
      if (!r.entered) throw new Error('no entry');
      const deadline = a.storage.positions.get(r.positionId)!.timeStopAt;
      a.storage.close();

      a.clock.advance(47 * HOUR_MS);
      const s1 = Storage.open({ path: db.path, mode: 'paper', clock: a.clock });
      expect(s1.positions.get(r.positionId)!.timeStopAt).toBe(deadline);
      expect(s1.positions.listTimeStopDue(a.clock.now())).toHaveLength(0);
      s1.close();

      a.clock.advance(HOUR_MS);
      const s2 = Storage.open({ path: db.path, mode: 'paper', clock: a.clock });
      expect(s2.positions.listTimeStopDue(a.clock.now()).map((p) => p.id)).toEqual([r.positionId]);
      s2.close();
    } finally {
      db.cleanup();
    }
  });
});

describe('LiveExecutor', () => {
  it('refuses to exist until live trading is implemented', () => {
    expect(() => new LiveExecutor()).toThrow(/not implemented/);
  });
});
