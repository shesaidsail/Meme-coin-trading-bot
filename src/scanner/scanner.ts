import { randomUUID } from 'node:crypto';
import type { Config } from '../config/schema.js';
import type { Clients } from '../clients/index.js';
import type { DexPair } from '../clients/dexscreener.js';
import { BudgetExhaustedError } from '../clients/errors.js';
import type { Storage } from '../storage/store.js';
import type { Clock } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import type { Candidate } from './types.js';

export interface ScanStats {
  scanId: string;
  discovered: Record<string, number>;
  sourceErrors: Record<string, string>;
  newMints: number;
  priced: number;
  /** Why priced mints were dropped before filtering. */
  dropped: Record<string, number>;
  inBand: number;
  candidates: Candidate[];
}

type Source = keyof Config['scanner']['sources'];

/**
 * Discovery → watchlist → pricing → market-cap band.
 *
 * Every source only contributes mints to a persistent watchlist. Each scan
 * prices the watchlist entries that are due (DexScreener, 30 per call) and
 * returns the in-band ones, closest to the target market cap first. Young
 * tokens simply stay on the watchlist until the filters accept their age.
 */
export class Scanner {
  constructor(
    private readonly deps: {
      config: Config;
      clients: Pick<Clients, 'dexscreener' | 'rugcheck' | 'birdeye'>;
      storage: Storage;
      clock: Clock;
      logger: Logger;
    },
  ) {}

  async scan(): Promise<ScanStats> {
    const { config, storage, clock, logger } = this.deps;
    const sc = config.scanner;
    const now = clock.now();
    const stats: ScanStats = {
      scanId: randomUUID(),
      discovered: {},
      sourceErrors: {},
      newMints: 0,
      priced: 0,
      dropped: {},
      inBand: 0,
      candidates: [],
    };

    // 1. Discovery. A failing source is logged and skipped, never fatal.
    const found: { mint: string; source: string }[] = [];
    for (const [source, fetch] of this.sources()) {
      try {
        const mints = await fetch();
        stats.discovered[source] = mints.length;
        found.push(...mints.map((mint) => ({ mint, source })));
      } catch (e) {
        if (e instanceof BudgetExhaustedError) throw e;
        stats.sourceErrors[source] = e instanceof Error ? e.message : String(e);
        logger.warn({ source, err: e }, 'scanner_source_failed');
      }
    }
    stats.newMints = storage.watchlist.upsertMany(found, now);
    storage.watchlist.prune(now - sc.watchExpiryHours * 3_600_000);

    // 2. Price what is due.
    const due = storage.watchlist.listDue({
      checkedBefore: now - sc.recheckCooldownMinutes * 60_000,
      seenAfter: now - sc.watchExpiryHours * 3_600_000,
      limit: sc.maxPricedPerScan,
    });
    if (!due.length) return stats;
    const pairs = await this.deps.clients.dexscreener.pairsForTokens(due.map((d) => d.mint));
    storage.watchlist.markChecked(
      due.map((d) => d.mint),
      now,
    );
    stats.priced = due.length;

    const sourcesByMint = new Map<string, string[]>();
    for (const f of found) sourcesByMint.set(f.mint, [...(sourcesByMint.get(f.mint) ?? []), f.source]);
    for (const d of due) if (!sourcesByMint.has(d.mint)) sourcesByMint.set(d.mint, [d.source]);

    // 3. Aggregate, band, and drop what we would not evaluate.
    const drop = (why: string) => (stats.dropped[why] = (stats.dropped[why] ?? 0) + 1);
    const byMint = groupPairs(pairs);
    const cands: Candidate[] = [];
    for (const d of due) {
      const c = buildCandidate(d.mint, byMint.get(d.mint) ?? [], config, sourcesByMint.get(d.mint) ?? []);
      if (typeof c === 'string') {
        drop(c);
        continue;
      }
      const { minMarketCapUsd, maxMarketCapUsd } = config.universe;
      if (c.marketCapUsd < minMarketCapUsd || c.marketCapUsd > maxMarketCapUsd) {
        drop('outside market cap band');
        continue;
      }
      stats.inBand++;
      if (storage.positions.getOpenByMint(c.mint)) {
        drop('already held');
        continue;
      }
      const last = storage.audit.lastEvaluatedAt(c.mint);
      if (last !== null && now - last < sc.reevaluateCooldownMinutes * 60_000) {
        drop('evaluated recently');
        continue;
      }
      cands.push(c);
    }

    const target = config.universe.targetMarketCapUsd;
    cands.sort((a, b) => Math.abs(Math.log(a.marketCapUsd / target)) - Math.abs(Math.log(b.marketCapUsd / target)));
    stats.candidates = cands.slice(0, config.loop.maxCandidatesPerScan);
    logger.info(
      {
        scanId: stats.scanId,
        discovered: stats.discovered,
        newMints: stats.newMints,
        priced: stats.priced,
        inBand: stats.inBand,
        candidates: stats.candidates.length,
        dropped: stats.dropped,
      },
      'scan_complete',
    );
    return stats;
  }

  private sources(): [Source, () => Promise<string[]>][] {
    const { dexscreener, rugcheck, birdeye } = this.deps.clients;
    const s = this.deps.config.scanner.sources;
    const u = this.deps.config.universe;
    const out: [Source, () => Promise<string[]>][] = [];
    if (s.dexscreenerProfiles) {
      out.push([
        'dexscreenerProfiles',
        async () => [...new Set([...(await dexscreener.latestProfiles()), ...(await dexscreener.recentlyUpdatedProfiles())])],
      ]);
    }
    if (s.dexscreenerTakeovers) out.push(['dexscreenerTakeovers', () => dexscreener.communityTakeovers()]);
    if (s.dexscreenerAds) out.push(['dexscreenerAds', () => dexscreener.latestAds()]);
    if (s.dexscreenerBoosts) {
      out.push([
        'dexscreenerBoosts',
        async () => [...new Set([...(await dexscreener.latestBoosts()), ...(await dexscreener.topBoosts())])],
      ]);
    }
    if (s.rugcheckNewTokens) out.push(['rugcheckNewTokens', () => rugcheck.newTokens()]);
    if (s.rugcheckRecent) out.push(['rugcheckRecent', () => rugcheck.recent()]);
    if (s.rugcheckTrending) out.push(['rugcheckTrending', () => rugcheck.trending()]);
    if (s.birdeye && birdeye) out.push(['birdeye', () => birdeye.tokensInMarketCapBand(u.minMarketCapUsd, u.maxMarketCapUsd)]);
    return out;
  }
}

function groupPairs(pairs: DexPair[]): Map<string, DexPair[]> {
  const m = new Map<string, DexPair[]>();
  for (const p of pairs) {
    const k = p.baseToken.address;
    m.set(k, [...(m.get(k) ?? []), p]);
  }
  return m;
}

/** Builds a candidate from a mint's pairs, or returns the reason it is not tradable for us. */
export function buildCandidate(mint: string, pairs: DexPair[], config: Config, sources: string[]): Candidate | string {
  if (!pairs.length) return 'no DexScreener pairs';
  const quotes = new Set([config.chain.solMint, config.chain.usdcMint]);
  const excluded = new Set(config.scanner.excludeDexIds);
  const quoted = pairs.filter((p) => quotes.has(p.quoteToken.address));
  if (!quoted.length) return 'no SOL/USDC pair';
  const eligible = quoted.filter((p) => !excluded.has(p.dexId));
  if (!eligible.length) return `only on excluded dex (${[...new Set(quoted.map((p) => p.dexId))].join(',')})`;

  const primary = [...eligible].sort((a, b) => (b.liquidity?.usd ?? -1) - (a.liquidity?.usd ?? -1))[0]!;
  const mcap = primary.marketCap ?? primary.fdv ?? null;
  if (mcap === null || !(mcap > 0)) return 'no market cap';
  const created = pairs.map((p) => p.pairCreatedAt).filter((t): t is number => typeof t === 'number' && t > 0);
  const price = primary.priceUsd ? Number(primary.priceUsd) : null;

  return {
    mint,
    symbol: primary.baseToken.symbol ?? null,
    name: primary.baseToken.name ?? null,
    marketCapUsd: mcap,
    primaryPair: {
      address: primary.pairAddress,
      dexId: primary.dexId,
      quoteMint: primary.quoteToken.address,
      liquidityUsd: primary.liquidity?.usd ?? null,
      labels: primary.labels ?? [],
    },
    totalLiquidityUsd: eligible.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0),
    pairAddresses: [...new Set(pairs.map((p) => p.pairAddress))],
    earliestPairCreatedAt: created.length ? Math.min(...created) : null,
    priceUsd: price !== null && Number.isFinite(price) ? price : null,
    sources,
  };
}
