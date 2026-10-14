import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PoolListener, POOL_FEEDS, toWsUrl, type WsLike } from '../../src/scanner/pool-listener.js';
import { makeDeps } from '../helpers/deps.js';
import { rpcOk } from '../helpers/fake-fetch.js';
import { fixture } from '../helpers/filter-ctx.js';

const GRAD_MINT = 'CfU5fAuvT4g4MoTmCg6BaYs39UYjhcxYBSc8nk6apump';
const CPMM_MINT = 'ExrHz3';
const GRAD_LOGS = ['Program log: Instruction: MigrateV2', 'Program log: Instruction: CreatePool'];

/** In-memory WebSocket that acknowledges logsSubscribe and lets tests push notifications. */
class FakeWs implements WsLike {
  static instances: FakeWs[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: { id: number; method: string; params: [{ mentions: string[] }] }[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeWs.instances.push(this);
    queueMicrotask(() => this.onopen?.({}));
  }
  send(data: string) {
    const m = JSON.parse(data);
    this.sent.push(m);
    // Subscription id = 100 + request id.
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: m.id, result: 100 + m.id }) }));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.onclose?.({}));
  }
  notify(address: string, signature: string, logs: string[], err: unknown = null) {
    const req = this.sent.find((s) => s.params[0].mentions[0] === address)!;
    this.onmessage?.({
      data: JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { subscription: 100 + req.id, result: { context: { slot: 1 }, value: { signature, err, logs } } } }),
    });
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(config: unknown = {}) {
  const d = makeDeps({ config });
  FakeWs.instances = [];
  const listener = new PoolListener({
    config: d.config,
    wsUrl: 'wss://rpc.test/?api-key=k',
    rpc: d.clients.rpc,
    storage: d.storage,
    clock: d.clock,
    logger: d.logger,
    wsFactory: (url) => new FakeWs(url),
    sleep: async () => undefined,
  });
  d.fake
    .on(/getTransaction.*"grad"/, { body: fixture('rpc-tx-pump-graduation.json') })
    .on(/getTransaction.*"cpmm"/, { body: fixture('rpc-tx-launchlab-cpmm.json') });
  return { ...d, listener };
}

describe('PoolListener', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it('derives the WebSocket URL from the RPC URL, keeping the key', () => {
    expect(toWsUrl('https://mainnet.helius-rpc.com/?api-key=abc')).toBe('wss://mainnet.helius-rpc.com/?api-key=abc');
    expect(toWsUrl('http://localhost:8899')).toBe('ws://localhost:8899');
  });

  it('subscribes only to the low-volume creation accounts of enabled feeds', async () => {
    const { listener } = setup({ scanner: { poolListener: { raydiumCpmm: false } } });
    listener.start();
    await flush();
    const ws = FakeWs.instances[0]!;
    expect(ws.sent.map((s) => [s.method, s.params[0].mentions])).toEqual([['logsSubscribe', [POOL_FEEDS.heliusPumpGraduation.address]]]);
    expect(listener.stats.connected).toBe(true);
    await listener.stop();
  });

  it('resolves a pump.fun graduation to its token, excluding SOL and the new LP mint, eligible after the minimum age', async () => {
    const { listener, storage } = setup();
    listener.start();
    await flush();
    FakeWs.instances[0]!.notify(POOL_FEEDS.heliusPumpGraduation.address, 'grad', GRAD_LOGS);
    await listener.idle();
    const w = storage.watchlist.get(GRAD_MINT)!;
    const tx = fixture<{ result: { blockTime: number } }>('rpc-tx-pump-graduation.json').result;
    expect(w.source).toBe('heliusPumpGraduation');
    expect(w.eligibleAt).toBe(tx.blockTime * 1000 + 30 * 60_000);
    expect(storage.watchlist.count()).toBe(1);
    expect(listener.stats).toMatchObject({ resolved: 1, mintsAdded: 1 });
    expect(storage.audit.list({ event: 'pool_discovered' })).toHaveLength(1);
    await listener.stop();
  });

  it('resolves a LaunchLab → CPMM migration, excluding the mints created in the transaction', async () => {
    const { listener, storage } = setup();
    listener.start();
    await flush();
    FakeWs.instances[0]!.notify(POOL_FEEDS.heliusRaydiumCpmm.address, 'cpmm', ['Program log: Instruction: MigrateToCpswap', 'Program log: Instruction: InitializeWithPermission']);
    await listener.idle();
    const mints = storage.db.prepare('SELECT mint FROM watchlist').all() as { mint: string }[];
    expect(mints).toHaveLength(1);
    expect(mints[0]!.mint.startsWith(CPMM_MINT)).toBe(true);
    await listener.stop();
  });

  it('ignores non-creation activity, failed transactions and duplicates without RPC calls', async () => {
    const { listener, fake } = setup();
    listener.start();
    await flush();
    const ws = FakeWs.instances[0]!;
    const addr = POOL_FEEDS.heliusPumpGraduation.address;
    ws.notify(addr, 'x1', ['Program log: Instruction: MigrateBondingCurveCreator']);
    // Live pattern: a bot calls MigrateV2 on a coin that is not ready; no pool is created.
    ws.notify(addr, 'x0', ['Program log: Instruction: MigrateV2']);
    ws.notify(addr, 'x2', GRAD_LOGS, { InstructionError: [0, 'Custom'] });
    ws.notify(addr, 'grad', GRAD_LOGS);
    ws.notify(addr, 'grad', GRAD_LOGS);
    await listener.idle();
    expect(fake.count(/getTransaction/)).toBe(1);
    expect(listener.stats.notifications).toBe(4);
    await listener.stop();
  });

  it('caps resolutions per hour', async () => {
    const { listener, fake } = setup({ scanner: { poolListener: { maxResolvesPerHour: 1 } } });
    fake.on(/getTransaction/, rpcOk(null));
    listener.start();
    await flush();
    const ws = FakeWs.instances[0]!;
    ws.notify(POOL_FEEDS.heliusPumpGraduation.address, 'grad', GRAD_LOGS);
    ws.notify(POOL_FEEDS.heliusPumpGraduation.address, 'other', GRAD_LOGS);
    await listener.idle();
    expect(listener.stats.droppedRateCap).toBe(1);
    await listener.stop();
  });

  it('reconnects with backoff and backfills signatures missed while disconnected', async () => {
    const { listener, fake, storage } = setup({ scanner: { poolListener: { raydiumCpmm: false } } });
    fake.on(/getSignaturesForAddress/, rpcOk([{ signature: 'grad', slot: 2, err: null }]));
    listener.start();
    await flush();
    // First connection: no history yet, so no backfill.
    expect(fake.count(/getSignaturesForAddress/)).toBe(0);
    FakeWs.instances[0]!.notify(POOL_FEEDS.heliusPumpGraduation.address, 'old', GRAD_LOGS);
    fake.on(/getTransaction.*"old"/, { body: fixture('rpc-tx-pump-graduation.json') });
    await listener.idle();

    FakeWs.instances[0]!.close();
    await flush();
    expect(listener.stats.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(FakeWs.instances).toHaveLength(2);
    expect(listener.stats.reconnects).toBe(1);
    await listener.idle();
    // Backfill asked for signatures until the last processed one.
    const call = fake.calls.find((c) => /getSignaturesForAddress/.test(JSON.stringify(c.body)))!;
    expect((call.body as { params: [string, { until: string }] }).params[1].until).toBe('old');
    expect(storage.getKv('pool_listener:last_signature:heliusPumpGraduation')).toBe('grad');
    await listener.stop();
  });

  it('reconnects when the socket goes quiet', async () => {
    const { listener, clock } = setup();
    listener.start();
    await flush();
    clock.advance(11 * 60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(FakeWs.instances[0]!.closed).toBe(true);
    await listener.stop();
  });
});

describe('watchlist eligibility and source attribution', () => {
  it('does not price a mint before eligible_at, and any immediate source makes it eligible now', () => {
    const { storage, clock } = makeDeps();
    const now = clock.now();
    storage.watchlist.upsertMany([{ mint: 'A', source: 'heliusPumpGraduation', eligibleAt: now + 60_000 }], now);
    const due = () => storage.watchlist.listDue({ now: clock.now(), checkedBefore: clock.now(), seenAfter: 0, limit: 10 }).map((w) => w.mint);
    expect(due()).toEqual([]);
    clock.advance(60_000);
    expect(due()).toEqual(['A']);

    storage.watchlist.upsertMany([{ mint: 'B', source: 'heliusPumpGraduation', eligibleAt: clock.now() + 60_000 }], clock.now());
    storage.watchlist.upsertMany([{ mint: 'B', source: 'dexscreenerProfiles' }], clock.now());
    expect(due()).toContain('B');
    expect(storage.watchlist.sourcesOf('B')).toEqual(['dexscreenerProfiles', 'heliusPumpGraduation'].sort());
  });

  it('reports per-source yield: discovered, first-to-report, candidates and passes', () => {
    const { storage, clock } = makeDeps();
    const t0 = clock.now();
    storage.watchlist.upsertMany([{ mint: 'A', source: 'heliusPumpGraduation' }, { mint: 'B', source: 'heliusPumpGraduation' }], t0);
    clock.advance(1000);
    storage.watchlist.upsertMany([{ mint: 'A', source: 'dexscreenerProfiles' }, { mint: 'C', source: 'dexscreenerProfiles' }], clock.now());
    const ev = (mint: string, verdict: 'passed' | 'rejected') =>
      storage.audit.recordEvaluation({ scanId: 's', mint, symbol: null, mcapUsd: 1, liquidityUsd: 1, verdict, rejectedBy: verdict === 'passed' ? [] : ['x'], decision: null, results: [] }, clock.now() + 1);
    ev('A', 'passed');
    ev('C', 'rejected');
    const y = Object.fromEntries(storage.watchlist.sourceYield(0).map((r) => [r.source, r]));
    expect(y.heliusPumpGraduation).toMatchObject({ discovered: 2, firstToReport: 2, evaluated: 1, passed: 1 });
    expect(y.dexscreenerProfiles).toMatchObject({ discovered: 2, firstToReport: 1, evaluated: 2, passed: 1 });
  });
});
