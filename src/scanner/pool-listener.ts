import type { Config } from '../config/schema.js';
import type { SolanaRpcClient } from '../clients/solana-rpc.js';
import { BudgetExhaustedError } from '../clients/errors.js';
import type { Storage } from '../storage/store.js';
import type { Clock } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import { realSleep, type Sleep } from '../clients/rate-limiter.js';

const hasIx = (logs: string, ...names: string[]) => names.some((n) => new RegExp(`Instruction: ${n}$`, 'm').test(logs));

/**
 * Pool-creation feeds. Each subscribes to an account that appears only in
 * pool-creation transactions, which keeps volume low. (Subscribing to the
 * AMM programs themselves streams every swap: ~500 events/s for PumpSwap.)
 * Addresses and log lines verified against live transactions.
 */
export const POOL_FEEDS = {
  heliusPumpGraduation: {
    /** pump.fun migration authority: present in every bonding-curve → PumpSwap migration. */
    address: '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
    /**
     * MigrateV2 is permissionless and bots call it on coins that are not
     * ready; those calls succeed without creating a pool. A graduation also
     * logs CreatePool.
     */
    isCreation: (logs: string) => hasIx(logs, 'MigrateV2', 'Migrate') && hasIx(logs, 'CreatePool'),
    configKey: 'pumpGraduations',
  },
  heliusRaydiumCpmm: {
    /** Raydium CPMM pool-creation fee receiver: present in every CPMM pool creation. */
    address: 'DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8',
    /** Pool initialisation (LaunchLab graduations log MigrateToCpswap + InitializeWithPermission). */
    isCreation: (logs: string) => hasIx(logs, 'Initialize', 'InitializeWithPermission'),
    configKey: 'raydiumCpmm',
  },
} as const;
export type PoolFeed = keyof typeof POOL_FEEDS;

/** Minimal WebSocket surface (the global WebSocket in Node ≥22 satisfies it). */
export interface WsLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type WsFactory = (url: string) => WsLike;

export interface ListenerStats {
  connected: boolean;
  reconnects: number;
  notifications: number;
  queued: number;
  resolved: number;
  mintsAdded: number;
  skippedNoMatch: number;
  droppedRateCap: number;
  errors: number;
}

interface Job {
  signature: string;
  feed: PoolFeed;
  /** Live notifications were already matched on their logs. */
  logsMatched: boolean;
  retried?: boolean;
}

const RETRY_DELAY_MS = 2_000;
const kvKey = (feed: PoolFeed) => `pool_listener:last_signature:${feed}`;

/** RPC HTTP URL → WebSocket URL (https://x/?api-key=k → wss://x/?api-key=k). */
export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
}

/**
 * Listens for new pools, resolves each creation transaction to the new
 * token's mint, and puts it on the watchlist with eligible_at = pool
 * creation + minimum token age. Reconnects with backoff, reconnects when
 * idle, and backfills missed signatures after each (re)connect.
 */
export class PoolListener {
  readonly stats: ListenerStats = {
    connected: false,
    reconnects: 0,
    notifications: 0,
    queued: 0,
    resolved: 0,
    mintsAdded: 0,
    skippedNoMatch: 0,
    droppedRateCap: 0,
    errors: 0,
  };

  private ws: WsLike | null = null;
  private stopped = true;
  private attempt = 0;
  private lastMessageAt = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subscriptions = new Map<number, PoolFeed>();
  private readonly requestFeed = new Map<number, PoolFeed>();
  private readonly seen = new Set<string>();
  private readonly queue: Job[] = [];
  private draining: Promise<void> | null = null;
  private readonly resolveTimes: number[] = [];

  constructor(
    private readonly deps: {
      config: Config;
      wsUrl: string;
      rpc: Pick<SolanaRpcClient, 'getTransaction' | 'getSignaturesForAddress'>;
      storage: Storage;
      clock: Clock;
      logger: Logger;
      wsFactory?: WsFactory;
      sleep?: Sleep;
    },
  ) {}

  get feeds(): PoolFeed[] {
    const cfg = this.deps.config.scanner.poolListener;
    return (Object.keys(POOL_FEEDS) as PoolFeed[]).filter((f) => cfg[POOL_FEEDS[f].configKey]);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    const idleMs = this.deps.config.scanner.poolListener.idleReconnectMinutes * 60_000;
    this.idleTimer = setInterval(() => {
      if (this.ws && this.deps.clock.now() - this.lastMessageAt > idleMs) {
        this.deps.logger.warn({ idleMs }, 'pool_listener_idle_reconnect');
        this.ws.close();
      }
    }, Math.min(idleMs, 30_000));
  }

  /** Stops listening and waits for queued resolutions to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.stats.connected = false;
    await this.draining;
  }

  /** Resolves all queued jobs (exposed for tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private connect(): void {
    const factory = this.deps.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
    const ws = factory(this.deps.wsUrl);
    this.ws = ws;
    this.subscriptions.clear();
    this.requestFeed.clear();
    this.lastMessageAt = this.deps.clock.now();

    ws.onopen = () => {
      let id = 1;
      for (const feed of this.feeds) {
        this.requestFeed.set(id, feed);
        ws.send(
          JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'logsSubscribe', params: [{ mentions: [POOL_FEEDS[feed].address] }, { commitment: 'confirmed' }] }),
        );
      }
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onerror = (ev) => this.deps.logger.warn({ err: (ev as { message?: string }).message ?? 'websocket error' }, 'pool_listener_ws_error');
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stats.connected = false;
      if (this.stopped) return;
      this.stats.reconnects++;
      const maxMs = this.deps.config.scanner.poolListener.reconnectMaxDelaySec * 1000;
      const delay = Math.min(maxMs, 1000 * 2 ** this.attempt++);
      this.deps.logger.warn({ delayMs: delay }, 'pool_listener_reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private onMessage(raw: string): void {
    this.lastMessageAt = this.deps.clock.now();
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: { subscription: number; result: { value: { signature: string; err: unknown; logs: string[] } } };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const feed = this.requestFeed.get(msg.id);
      if (!feed) return;
      if (msg.error || typeof msg.result !== 'number') {
        this.stats.errors++;
        this.deps.logger.error({ feed, error: msg.error?.message }, 'pool_listener_subscribe_failed');
        return;
      }
      this.subscriptions.set(msg.result, feed);
      if (this.subscriptions.size === this.feeds.length) {
        this.stats.connected = true;
        this.attempt = 0;
        this.deps.logger.info({ feeds: this.feeds }, 'pool_listener_subscribed');
        void this.backfill();
      }
      return;
    }
    if (msg.method !== 'logsNotification' || !msg.params) return;
    const feed = this.subscriptions.get(msg.params.subscription);
    const v = msg.params.result.value;
    if (!feed || v.err) return;
    this.stats.notifications++;
    if (!POOL_FEEDS[feed].isCreation(v.logs.join('\n'))) return;
    this.enqueue({ signature: v.signature, feed, logsMatched: true });
  }

  /** Fetches signatures missed while disconnected (bounded), oldest first. */
  private async backfill(): Promise<void> {
    const limit = this.deps.config.scanner.poolListener.backfillLimit;
    if (limit === 0) return;
    for (const feed of this.feeds) {
      const last = this.deps.storage.getKv(kvKey(feed));
      if (!last) continue;
      try {
        const sigs = await this.deps.rpc.getSignaturesForAddress(POOL_FEEDS[feed].address, { until: last, limit });
        const missed = sigs.filter((s) => !s.err).reverse();
        if (missed.length) this.deps.logger.info({ feed, missed: missed.length }, 'pool_listener_backfill');
        for (const s of missed) this.enqueue({ signature: s.signature, feed, logsMatched: false });
      } catch (e) {
        this.stats.errors++;
        this.deps.logger.warn({ feed, err: e }, 'pool_listener_backfill_failed');
      }
    }
  }

  enqueue(job: Job): void {
    if (this.seen.has(job.signature)) return;
    this.seen.add(job.signature);
    if (this.seen.size > 20_000) this.seen.delete(this.seen.values().next().value!);
    this.queue.push(job);
    this.stats.queued++;
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const job = this.queue.shift()!;
      if (job.retried) await (this.deps.sleep ?? realSleep)(RETRY_DELAY_MS);
      await this.resolve(job);
    }
  }

  private underRateCap(): boolean {
    const now = this.deps.clock.now();
    while (this.resolveTimes.length && this.resolveTimes[0]! <= now - 3_600_000) this.resolveTimes.shift();
    if (this.resolveTimes.length >= this.deps.config.scanner.poolListener.maxResolvesPerHour) return false;
    this.resolveTimes.push(now);
    return true;
  }

  private async resolve(job: Job): Promise<void> {
    const { storage, clock, logger, config } = this.deps;
    if (!this.underRateCap()) {
      this.stats.droppedRateCap++;
      if (this.stats.droppedRateCap % 50 === 1) logger.warn({ dropped: this.stats.droppedRateCap }, 'pool_listener_rate_cap');
      return;
    }
    try {
      const tx = await this.deps.rpc.getTransaction(job.signature);
      if (!tx) {
        // Very fresh transactions are occasionally not yet retrievable; retry once at the back of the queue.
        if (!job.retried) this.queue.push({ ...job, retried: true });
        return;
      }
      storage.setKv(kvKey(job.feed), job.signature);
      if (tx.failed) return;
      if (!job.logsMatched && !POOL_FEEDS[job.feed].isCreation(tx.logMessages.join('\n'))) {
        this.stats.skippedNoMatch++;
        return;
      }
      const exclude = new Set([config.chain.solMint, config.chain.usdcMint, ...tx.initializedMints]);
      const mints = [...new Set(tx.postTokenBalances.map((b) => b.mint))].filter((m) => !exclude.has(m));
      this.stats.resolved++;
      if (!mints.length) return;
      const createdAt = tx.blockTime ? tx.blockTime * 1000 : clock.now();
      const eligibleAt = createdAt + config.filters.tokenAge.minAgeMinutes * 60_000;
      const added = storage.watchlist.upsertMany(
        mints.map((mint) => ({ mint, source: job.feed, eligibleAt })),
        clock.now(),
      );
      this.stats.mintsAdded += added;
      storage.audit.log('pool_discovered', clock.now(), {
        mint: mints[0] ?? null,
        data: { source: job.feed, signature: job.signature, mints, createdAt, eligibleAt },
      });
      logger.info({ source: job.feed, mints, eligibleAt: new Date(eligibleAt).toISOString() }, 'pool_discovered');
    } catch (e) {
      this.stats.errors++;
      if (e instanceof BudgetExhaustedError) logger.warn({ err: e }, 'pool_listener_budget_exhausted');
      else logger.warn({ err: e, signature: job.signature }, 'pool_listener_resolve_failed');
    }
  }
}
