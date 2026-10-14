import type { Config } from '../config/schema.js';
import type { Clients } from '../clients/index.js';
import type { MintInfo } from '../clients/solana-rpc.js';
import type { RugcheckReport } from '../clients/rugcheck.js';
import type { Quote, QuoteResult } from '../clients/jupiter.js';
import { ApiError, BudgetExhaustedError } from '../clients/errors.js';
import type { Candidate } from '../scanner/types.js';
import type { Clock } from '../util/clock.js';
import { analyzeLaunch, type LaunchAnalysis } from './launch-analysis.js';

export type Source = 'onchain' | 'rugcheck' | 'jupiter' | 'dexscreener';

/** A lazily fetched datum: either a value with its source, or why it is unavailable. */
export type Data<T> = { ok: true; value: T; source: Source } | { ok: false; reason: string };

export interface Holder {
  owner: string;
  /** Token account address(es) aggregated into this owner. */
  accounts: string[];
  amount: bigint;
  fraction: number;
}

export interface HoneypotQuotes {
  buy: QuoteResult;
  sell: QuoteResult | null;
  sizeLamports: bigint;
}

export interface ContextDeps {
  config: Config;
  clients: Pick<Clients, 'rpc' | 'rugcheck' | 'jupiter'>;
  clock: Clock;
  /** SOL amount of the entry we would make; honeypot quotes are sized to it. */
  intendedSizeLamports: bigint;
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

function describe(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Per-token data shared by all filters. Each source is fetched at most once
 * (memoised promise), so filters can freely ask for the same data.
 * Budget exhaustion is rethrown (the scan must stop, not record a data gap);
 * every other fetch error becomes `{ ok: false, reason }`.
 */
export class TokenContext {
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(
    readonly candidate: Candidate,
    readonly deps: ContextDeps,
  ) {}

  get mint(): string {
    return this.candidate.mint;
  }

  get config(): Config {
    return this.deps.config;
  }

  now(): number {
    return this.deps.clock.now();
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.memo.set(key, p);
    }
    return p;
  }

  private async guard<T>(fn: () => Promise<Data<T>>): Promise<Data<T>> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BudgetExhaustedError) throw e;
      return { ok: false, reason: describe(e) };
    }
  }

  mintInfo(): Promise<Data<MintInfo>> {
    return this.once('mint', () =>
      this.guard(async () => {
        const m = await this.deps.clients.rpc.getMintInfo(this.mint);
        return m ? { ok: true, value: m, source: 'onchain' } : { ok: false, reason: 'mint account not found on-chain' };
      }),
    );
  }

  /** The RugCheck report if a filter already fetched it; never triggers a call. */
  cachedRugcheck(): Promise<Data<RugcheckReport>> | null {
    return (this.memo.get('rugcheck') as Promise<Data<RugcheckReport>> | undefined) ?? null;
  }

  rugcheck(): Promise<Data<RugcheckReport>> {
    return this.once('rugcheck', () =>
      this.guard(async () => {
        const r = await this.deps.clients.rugcheck.report(this.mint);
        return r ? { ok: true, value: r, source: 'rugcheck' } : { ok: false, reason: 'RugCheck has no report for this token' };
      }),
    );
  }

  /** Total supply in raw units: on-chain first, RugCheck as fallback. */
  async supply(): Promise<Data<bigint>> {
    const m = await this.mintInfo();
    if (m.ok) return { ok: true, value: m.value.supply, source: 'onchain' };
    const r = await this.rugcheck();
    if (r.ok && r.value.token && r.value.token.supply > 0) {
      return { ok: true, value: BigInt(Math.round(r.value.token.supply)), source: 'rugcheck' };
    }
    return { ok: false, reason: `supply unavailable (${m.reason})` };
  }

  /**
   * Owners that are not real holders: configured excludes, every DexScreener
   * pair address, RugCheck market accounts and accounts RugCheck labels AMM.
   */
  async excludedOwners(): Promise<Set<string>> {
    return this.once('excluded', async () => {
      const s = new Set<string>([...this.config.filters.holderConcentration.excludeAddresses, ...this.candidate.pairAddresses]);
      const r = await this.rugcheck();
      if (r.ok) {
        for (const m of r.value.markets ?? []) s.add(m.pubkey);
        for (const [addr, info] of Object.entries(r.value.knownAccounts ?? {})) {
          if (info.type === 'AMM') s.add(addr);
        }
      }
      return s;
    });
  }

  /** Largest holders aggregated by owner wallet. On-chain first (top 20 accounts), RugCheck as fallback. */
  holders(): Promise<Data<Holder[]>> {
    return this.once('holders', () =>
      this.guard(async () => {
        const supply = await this.supply();
        if (!supply.ok) return supply;
        const total = supply.value;
        const frac = (a: bigint) => (total > 0n ? Number((a * 1_000_000n) / total) / 1_000_000 : 0);

        let onchainReason = '';
        try {
          const accounts = await this.deps.clients.rpc.getTokenLargestAccounts(this.mint);
          const owners = await this.deps.clients.rpc.getTokenAccountOwners(accounts.map((a) => a.address));
          const byOwner = new Map<string, Holder>();
          for (const a of accounts) {
            const owner = owners.get(a.address) ?? a.address;
            const h = byOwner.get(owner) ?? { owner, accounts: [], amount: 0n, fraction: 0 };
            h.accounts.push(a.address);
            h.amount += a.amount;
            byOwner.set(owner, h);
          }
          const list = [...byOwner.values()].map((h) => ({ ...h, fraction: frac(h.amount) }));
          return { ok: true, value: list.sort((a, b) => (b.amount > a.amount ? 1 : -1)), source: 'onchain' };
        } catch (e) {
          if (e instanceof BudgetExhaustedError) throw e;
          onchainReason = describe(e);
        }

        const r = await this.rugcheck();
        if (r.ok && r.value.topHolders && r.value.topHolders.length > 0) {
          const byOwner = new Map<string, Holder>();
          for (const h of r.value.topHolders) {
            const owner = h.owner ?? h.address;
            const cur = byOwner.get(owner) ?? { owner, accounts: [], amount: 0n, fraction: 0 };
            cur.accounts.push(h.address);
            cur.amount += BigInt(Math.round(h.amount));
            cur.fraction += h.pct / 100;
            byOwner.set(owner, cur);
          }
          return { ok: true, value: [...byOwner.values()].sort((a, b) => b.fraction - a.fraction), source: 'rugcheck' };
        }
        return { ok: false, reason: `holders unavailable (on-chain: ${onchainReason}; RugCheck: ${r.ok ? 'no topHolders' : r.reason})` };
      }),
    );
  }

  /** LP mint supply, for on-chain verification that LP was burned. */
  lpSupply(lpMint: string): Promise<Data<bigint>> {
    return this.once(`lp:${lpMint}`, () =>
      this.guard(async () => ({ ok: true, value: await this.deps.clients.rpc.getTokenSupply(lpMint), source: 'onchain' })),
    );
  }

  static hasRealLpMint(lpMint: string | null | undefined): lpMint is string {
    return !!lpMint && lpMint !== SYSTEM_PROGRAM;
  }

  /** Buy quote for our intended size, then a sell quote for what that buy would return. */
  honeypotQuotes(): Promise<Data<HoneypotQuotes>> {
    return this.once('honeypot', () =>
      this.guard(async () => {
        const { solMint } = this.config.chain;
        const size = this.deps.intendedSizeLamports;
        const buy = await this.deps.clients.jupiter.quote({
          inputMint: solMint,
          outputMint: this.mint,
          amount: size,
          slippageBps: this.config.execution.buySlippageBps,
        });
        let sell: QuoteResult | null = null;
        if (buy.ok) {
          sell = await this.deps.clients.jupiter.quote({
            inputMint: this.mint,
            outputMint: solMint,
            amount: buy.quote.outAmount,
            slippageBps: this.config.execution.sell.initialSlippageBps,
          });
        }
        return { ok: true, value: { buy, sell, sizeLamports: size }, source: 'jupiter' };
      }),
    );
  }

  /** On-chain launch-window analysis (bounded by config; busy tokens are unavailable). */
  launch(): Promise<Data<LaunchAnalysis>> {
    return this.once('launch', () =>
      this.guard(async () => {
        const f = this.config.filters.bundledLaunch;
        const supply = await this.supply();
        if (!supply.ok) return supply;

        const sigs: { signature: string; slot: number; err: unknown }[] = [];
        let before: string | undefined;
        let reachedStart = false;
        for (let page = 0; page < f.maxSignaturePages; page++) {
          const batch = await this.deps.clients.rpc.getSignaturesForAddress(this.mint, { limit: 1000, ...(before ? { before } : {}) });
          sigs.push(...batch);
          if (batch.length < 1000) {
            reachedStart = true;
            break;
          }
          before = batch[batch.length - 1]!.signature;
        }
        if (!reachedStart) {
          return { ok: false, reason: `history longer than ${f.maxSignaturePages * 1000} transactions; launch not reached` };
        }
        if (sigs.length === 0) return { ok: false, reason: 'no transactions found for mint' };

        const firstSlot = Math.min(...sigs.map((s) => s.slot));
        const inWindow = sigs
          .filter((s) => s.slot < firstSlot + f.launchSlots && !s.err)
          .sort((a, b) => a.slot - b.slot);
        const selected = inWindow.slice(0, f.maxLaunchTransactions);
        const txs = [];
        for (const s of selected) {
          const tx = await this.deps.clients.rpc.getTransaction(s.signature);
          if (tx) txs.push(tx);
        }
        const excluded = await this.excludedOwners();
        const a = analyzeLaunch(txs, this.mint, supply.value, excluded, f.launchSlots, inWindow.length > selected.length);
        return a ? { ok: true, value: a, source: 'onchain' } : { ok: false, reason: 'launch transactions could not be parsed' };
      }),
    );
  }
}

export type { Quote };
