import { z } from 'zod';
import type { HttpClient } from './http.js';
import { ApiError } from './errors.js';

const num = z.number().nullish();

const RiskSchema = z.looseObject({
  name: z.string(),
  level: z.string(),
  score: z.number().nullish(),
  value: z.string().nullish(),
  description: z.string().nullish(),
});

const MarketSchema = z.looseObject({
  pubkey: z.string(),
  marketType: z.string(),
  mintA: z.string().nullish(),
  mintB: z.string().nullish(),
  mintLP: z.string().nullish(),
  lp: z
    .looseObject({
      lpLockedPct: num,
      quoteUSD: num,
      baseUSD: num,
      lpTotalSupply: num,
      lpCurrentSupply: num,
      lpLocked: num,
      lpUnlocked: num,
    })
    .nullish(),
});

const ReportSchema = z.looseObject({
  mint: z.string(),
  tokenProgram: z.string().nullish(),
  creator: z.string().nullish(),
  creatorBalance: num,
  creatorTokens: z.array(z.unknown()).nullish(),
  token: z.looseObject({ supply: z.number(), decimals: z.number() }).nullish(),
  mintAuthority: z.string().nullish(),
  freezeAuthority: z.string().nullish(),
  topHolders: z
    .array(
      z.looseObject({
        address: z.string(),
        owner: z.string().nullish(),
        amount: z.number(),
        pct: z.number(),
        insider: z.boolean().nullish(),
      }),
    )
    .nullish(),
  markets: z.array(MarketSchema).nullish(),
  risks: z.array(RiskSchema).nullish(),
  /** Raw risk score: the sum of the individual risk scores. Higher = riskier. */
  score: num,
  /** 0..100, higher = riskier (verified against live reports). */
  score_normalised: num,
  rugged: z.boolean().nullish(),
  totalHolders: num,
  totalMarketLiquidity: num,
  detectedAt: z.string().nullish(),
  graphInsidersDetected: num,
  insiderNetworks: z
    .array(
      z.looseObject({
        id: z.string().nullish(),
        size: num,
        type: z.string().nullish(),
        tokenAmount: num,
        currentHolding: num,
        activeAccounts: num,
      }),
    )
    .nullish(),
  knownAccounts: z.record(z.string(), z.looseObject({ name: z.string().nullish(), type: z.string().nullish() })).nullish(),
  launchpad: z.looseObject({ platform: z.string().nullish(), name: z.string().nullish() }).nullish(),
});

export type RugcheckReport = z.infer<typeof ReportSchema>;
export type RugcheckMarket = z.infer<typeof MarketSchema>;

/** List endpoints return null when empty (observed on /stats/trending). */
const MintListSchema = z.array(z.looseObject({ mint: z.string() })).nullable().transform((v) => v ?? []);

export class RugcheckClient {
  constructor(private readonly http: HttpClient) {}

  /** Full report, or null if RugCheck does not know the token. */
  async report(mint: string): Promise<RugcheckReport | null> {
    try {
      return await this.http.request({ path: `/tokens/${mint}/report`, schema: ReportSchema });
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'http' && (e.status === 404 || e.status === 400)) return null;
      throw e;
    }
  }

  private async mints(path: string): Promise<string[]> {
    const rows = await this.http.request({ path, schema: MintListSchema });
    return [...new Set(rows.map((r) => r.mint))];
  }

  /** Just-created tokens (too young to trade; they go on the watchlist). */
  newTokens(): Promise<string[]> {
    return this.mints('/stats/new_tokens');
  }

  recent(): Promise<string[]> {
    return this.mints('/stats/recent');
  }

  trending(): Promise<string[]> {
    return this.mints('/stats/trending');
  }
}
