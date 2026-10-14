import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Storage, StorageError } from '../../src/storage/store.js';
import { migrate, MIGRATIONS } from '../../src/storage/migrations.js';
import { FakeClock, HOUR_MS } from '../../src/util/clock.js';
import { solToLamports } from '../../src/util/units.js';
import { tempDb, openStore, newPosition, buyFill, sellAttempt } from '../helpers/storage.js';

let db: { path: string; cleanup: () => void };
let clock: FakeClock;
let store: Storage;

beforeEach(() => {
  db = tempDb();
  clock = new FakeClock(Date.UTC(2026, 9, 1, 12));
  store = openStore(db.path, clock);
  store.ledger.initialise(solToLamports(10), clock.now());
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  db.cleanup();
});

describe('migrations', () => {
  it('are idempotent', () => {
    const raw = new Database(':memory:');
    expect(migrate(raw, 0)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(migrate(raw, 0)).toEqual([]);
    raw.close();
  });
});

describe('mode isolation', () => {
  it('refuses to open a paper database in live mode', () => {
    store.close();
    expect(() => openStore(db.path, clock, 'live')).toThrow(StorageError);
    store = openStore(db.path, clock, 'paper'); // still fine in its own mode
  });
});

describe('cash ledger', () => {
  it('initialises the starting balance once, even across restarts', () => {
    expect(store.ledger.balance()).toBe(solToLamports(10));
    store.close();
    store = openStore(db.path, clock);
    expect(store.ledger.initialise(solToLamports(99), clock.now())).toBe(false);
    expect(store.ledger.balance()).toBe(solToLamports(10));
    expect(store.ledger.initialBalance()).toBe(solToLamports(10));
  });

  it('refuses to overdraw', () => {
    expect(() => store.ledger.append('buy', -solToLamports(11), clock.now())).toThrow(/negative/);
    expect(store.ledger.balance()).toBe(solToLamports(10));
  });
});

describe('opening positions', () => {
  it('writes position, trade, cash debit and audit entry together', () => {
    const { positionId, tradeId } = store.openPosition(newPosition(clock), buyFill());
    const p = store.positions.get(positionId)!;
    expect(p.status).toBe('open');
    expect(p.tokenAmountRaw).toBe(1_000_000_000n);
    expect(p.initialTokenAmountRaw).toBe(1_000_000_000n);
    expect(store.ledger.balance()).toBe(solToLamports(9.5));
    const trades = store.trades.listByPosition(positionId);
    expect(trades.map((t) => t.id)).toEqual([tradeId]);
    expect(trades[0]!.side).toBe('buy');
    expect(store.audit.list({ event: 'position_opened' })).toHaveLength(1);
  });

  it('is atomic: an overdrawing entry leaves no trace', () => {
    const big = newPosition(clock, { costBasisLamports: solToLamports(50) });
    expect(() => store.openPosition(big, buyFill())).toThrow(/negative/);
    expect(store.positions.countOpen()).toBe(0);
    expect(store.ledger.balance()).toBe(solToLamports(10));
    expect(store.audit.list()).toHaveLength(0);
    const tradeCount = store.db.prepare('SELECT COUNT(*) AS n FROM trades').get() as { n: number };
    expect(tradeCount.n).toBe(0);
  });

  it('allows only one open position per mint', () => {
    store.openPosition(newPosition(clock), buyFill());
    expect(() => store.openPosition(newPosition(clock), buyFill())).toThrow(/UNIQUE/);
    expect(store.positions.hasEverHeld(newPosition(clock).mint)).toBe(true);
  });

  it('rejects a position in the wrong mode', () => {
    expect(() => store.openPosition(newPosition(clock, { mode: 'live' }), buyFill())).toThrow(StorageError);
  });

  it('records failed buys with their fees but no position', () => {
    store.recordFailedBuy('MintX', buyFill({ status: 'failed', inFilledRaw: 0n, outAmountRaw: 0n, feeLamports: 5_000n, error: 'slippage' }));
    expect(store.positions.countOpen()).toBe(0);
    expect(store.ledger.balance()).toBe(solToLamports(10) - 5_000n);
    expect(store.audit.list({ event: 'buy_failed' })).toHaveLength(1);
  });
});

describe('selling', () => {
  it('handles partial fills, failed attempts and a final close with rent refund', () => {
    const { positionId } = store.openPosition(newPosition(clock), buyFill());

    // attempt 1: fails, pays a fee (live-style)
    let p = store.recordSellAttempt(
      positionId,
      sellAttempt({ status: 'failed', inFilledRaw: 0n, outAmountRaw: 0n, feeLamports: 5_000n, error: 'slippage exceeded' }),
    );
    expect(p.tokenAmountRaw).toBe(1_000_000_000n);
    expect(p.realizedLamports).toBe(-5_000n);

    // attempt 2: partial fill, 60% sold
    p = store.recordSellAttempt(
      positionId,
      sellAttempt({ status: 'partial', attempt: 2, slippageBps: 600, inFilledRaw: 600_000_000n, outAmountRaw: solToLamports(0.8), feeLamports: 100_000n }),
    );
    expect(p.status).toBe('open');
    expect(p.tokenAmountRaw).toBe(400_000_000n);

    // attempt 3: rest fills, close
    p = store.recordSellAttempt(
      positionId,
      sellAttempt({ attempt: 3, slippageBps: 900, inAmountRaw: 400_000_000n, inFilledRaw: 400_000_000n, outAmountRaw: solToLamports(0.5), feeLamports: 100_000n }),
      { reason: 'take_profit', exitSolUsd: 160, rentRefundLamports: 2_039_280n },
    );
    expect(p.status).toBe('closed');
    expect(p.exitReason).toBe('take_profit');
    expect(p.tokenAmountRaw).toBe(0n);
    const expectedRealized = -5_000n + (solToLamports(0.8) - 100_000n) + (solToLamports(0.5) - 100_000n) + 2_039_280n;
    expect(p.realizedLamports).toBe(expectedRealized);
    expect(store.ledger.balance()).toBe(solToLamports(9.5) + expectedRealized);
    expect(store.trades.listByPosition(positionId).map((t) => t.status)).toEqual(['filled', 'failed', 'partial', 'filled']);
    expect(store.audit.list({ event: 'sell_failed' })).toHaveLength(1);
    expect(store.audit.list({ event: 'sell_fill' })).toHaveLength(2);
    expect(store.audit.list({ event: 'position_closed' })).toHaveLength(1);
  });

  it('cannot oversell or sell a closed position', () => {
    const { positionId } = store.openPosition(newPosition(clock), buyFill());
    expect(() =>
      store.recordSellAttempt(positionId, sellAttempt({ inFilledRaw: 2_000_000_000n })),
    ).toThrow(RangeError);
    store.recordSellAttempt(positionId, sellAttempt(), { reason: 'time_stop', exitSolUsd: null });
    expect(() => store.recordSellAttempt(positionId, sellAttempt())).toThrow(/not open/);
  });

  it('rejects a "failed" sell that claims a fill', () => {
    const { positionId } = store.openPosition(newPosition(clock), buyFill());
    expect(() =>
      store.recordSellAttempt(positionId, sellAttempt({ status: 'failed' })),
    ).toThrow(StorageError);
  });
});

describe('quote tracking', () => {
  it('flags a position unquotable after N consecutive failures and clears on success', () => {
    const { positionId } = store.openPosition(newPosition(clock), buyFill());
    const t0 = clock.now();
    expect(store.positions.recordQuoteFailure(positionId, t0, 3).unquotableSince).toBeNull();
    expect(store.positions.recordQuoteFailure(positionId, t0 + 1, 3).unquotableSince).toBeNull();
    const p3 = store.positions.recordQuoteFailure(positionId, t0 + 2, 3);
    expect(p3.consecutiveQuoteFailures).toBe(3);
    expect(p3.unquotableSince).toBe(t0 + 2);
    // stays stamped at the first time it crossed the threshold
    expect(store.positions.recordQuoteFailure(positionId, t0 + 3, 3).unquotableSince).toBe(t0 + 2);

    store.positions.recordQuote(positionId, solToLamports(0.6), t0 + 4);
    const ok = store.positions.get(positionId)!;
    expect(ok.consecutiveQuoteFailures).toBe(0);
    expect(ok.unquotableSince).toBeNull();
    expect(ok.lastQuoteLamports).toBe(solToLamports(0.6));
  });

  it('tracks the peak quote', () => {
    const { positionId } = store.openPosition(newPosition(clock), buyFill());
    store.positions.recordQuote(positionId, 5n, 1);
    store.positions.recordQuote(positionId, 9n, 2);
    store.positions.recordQuote(positionId, 7n, 3);
    expect(store.positions.get(positionId)!.peakQuoteLamports).toBe(9n);
  });

  it('records the shadow stop-loss only the first time', () => {
    const { positionId } = store.openPosition(newPosition(clock), buyFill());
    expect(store.positions.markShadowStopLoss(positionId, 100, 42n)).toBe(true);
    expect(store.positions.markShadowStopLoss(positionId, 200, 10n)).toBe(false);
    const p = store.positions.get(positionId)!;
    expect(p.shadowSlTriggeredAt).toBe(100);
    expect(p.shadowSlValueLamports).toBe(42n);
  });
});

describe('filter results', () => {
  it('counts real failures separately from insufficient-data rejections', () => {
    const base = { scanId: 's1', symbol: null, mcapUsd: 300_000, liquidityUsd: 50_000, decision: null };
    store.audit.recordEvaluation(
      {
        ...base,
        mint: 'A',
        verdict: 'rejected',
        rejectedBy: ['liquidity'],
        results: [
          { filter: 'mintAuthority', outcome: 'pass', reason: null },
          { filter: 'liquidity', outcome: 'fail', reason: 'liquidity $12,000 < $40,000' },
        ],
      },
      clock.now(),
    );
    store.audit.recordEvaluation(
      {
        ...base,
        mint: 'B',
        verdict: 'rejected',
        rejectedBy: ['bundledLaunch'],
        results: [
          { filter: 'mintAuthority', outcome: 'pass', reason: null },
          { filter: 'bundledLaunch', outcome: 'insufficient_data', reason: 'no launch transactions', data: { slot: 1n } },
          { filter: 'devWallet', outcome: 'warn', reason: 'creator unknown' },
        ],
      },
      clock.now(),
    );
    const counts = store.audit.filterOutcomeCounts();
    expect(counts.mintAuthority!.pass).toBe(2);
    expect(counts.liquidity!.fail).toBe(1);
    expect(counts.bundledLaunch!.insufficient_data).toBe(1);
    expect(counts.bundledLaunch!.fail).toBe(0);
    expect(counts.devWallet!.warn).toBe(1);
    expect(store.audit.evaluationCounts()).toEqual({ passed: 0, rejected: 2 });
    expect(store.audit.lastEvaluatedAt('A')).toBe(clock.now());
    expect(store.audit.lastEvaluatedAt('Z')).toBeNull();
  });

  it('scrubs credentials from stored audit data', () => {
    store.audit.log('api_error', clock.now(), { data: { url: 'https://rpc/?api-key=SECRET1' } });
    expect(JSON.stringify(store.audit.list())).not.toContain('SECRET1');
  });
});

describe('api usage', () => {
  it('accumulates per provider per UTC day and survives restarts', () => {
    store.usage.add('jupiter', clock.now(), { units: 1, calls: 1 });
    store.usage.add('jupiter', clock.now(), { units: 2, calls: 1, throttled: 1 });
    store.close();
    store = openStore(db.path, clock);
    expect(store.usage.get('jupiter', clock.now())).toMatchObject({ units: 3, calls: 2, throttled: 1 });
    clock.advance(24 * HOUR_MS);
    expect(store.usage.get('jupiter', clock.now()).units).toBe(0);
  });
});

describe('equity snapshots', () => {
  it('stores and returns the latest and first snapshot', () => {
    const snap = {
      cashLamports: 1n,
      positionsLamports: 2n,
      equityLamports: 3n,
      solUsd: 150,
      openPositions: 1,
      unquotablePositions: 0,
    };
    store.snapshots.insert({ ...snap, ts: 1 });
    store.snapshots.insert({ ...snap, ts: 2, equityLamports: 9n });
    expect(store.snapshots.first()!.equityLamports).toBe(3n);
    expect(store.snapshots.latest()!.equityLamports).toBe(9n);
  });
});
