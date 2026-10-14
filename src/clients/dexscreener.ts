import { z } from 'zod';
import type { HttpClient } from './http.js';

const TokenRefSchema = z.array(z.looseObject({ chainId: z.string(), tokenAddress: z.string() }));

const PairSchema = z.looseObject({
  chainId: z.string(),
  dexId: z.string(),
  pairAddress: z.string(),
  labels: z.array(z.string()).nullish(),
  baseToken: z.looseObject({ address: z.string(), name: z.string().nullish(), symbol: z.string().nullish() }),
  quoteToken: z.looseObject({ address: z.string(), symbol: z.string().nullish() }),
  priceUsd: z.string().nullish(),
  priceNative: z.string().nullish(),
  liquidity: z.looseObject({ usd: z.number().nullish(), base: z.number().nullish(), quote: z.number().nullish() }).nullish(),
  marketCap: z.number().nullish(),
  fdv: z.number().nullish(),
  pairCreatedAt: z.number().nullish(),
  volume: z.record(z.string(), z.number()).nullish(),
});
const PairsSchema = z.array(PairSchema);

export type DexPair = z.infer<typeof PairSchema>;

const MAX_TOKENS_PER_CALL = 30;

export class DexScreenerClient {
  constructor(private readonly http: HttpClient) {}

  private async solanaRefs(path: string): Promise<string[]> {
    const rows = await this.http.request({ path, schema: TokenRefSchema });
    return [...new Set(rows.filter((r) => r.chainId === 'solana').map((r) => r.tokenAddress))];
  }

  /** Newest token profiles (paid listings; a biased but cheap discovery feed). */
  latestProfiles(): Promise<string[]> {
    return this.solanaRefs('/token-profiles/latest/v1');
  }

  recentlyUpdatedProfiles(): Promise<string[]> {
    return this.solanaRefs('/token-profiles/recent-updates/v1');
  }

  communityTakeovers(): Promise<string[]> {
    return this.solanaRefs('/community-takeovers/latest/v1');
  }

  latestAds(): Promise<string[]> {
    return this.solanaRefs('/ads/latest/v1');
  }

  latestBoosts(): Promise<string[]> {
    return this.solanaRefs('/token-boosts/latest/v1');
  }

  topBoosts(): Promise<string[]> {
    return this.solanaRefs('/token-boosts/top/v1');
  }

  /** All known pairs for up to N mints, 30 mints per request. */
  async pairsForTokens(mints: string[]): Promise<DexPair[]> {
    const out: DexPair[] = [];
    for (let i = 0; i < mints.length; i += MAX_TOKENS_PER_CALL) {
      const chunk = mints.slice(i, i + MAX_TOKENS_PER_CALL);
      const pairs = await this.http.request({ path: `/tokens/v1/solana/${chunk.join(',')}`, schema: PairsSchema });
      out.push(...pairs.filter((p) => p.chainId === 'solana'));
    }
    return out;
  }
}
