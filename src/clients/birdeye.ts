import { z } from 'zod';
import type { HttpClient } from './http.js';

/**
 * Birdeye is optional (requires BIRDEYE_API_KEY, sent by the HttpClient as
 * X-API-KEY). Response shapes follow Birdeye's public docs; they could not
 * be verified without a key, so parsing is deliberately lenient.
 */
const TokenListSchema = z.looseObject({
  success: z.boolean().optional(),
  data: z.looseObject({
    items: z
      .array(
        z.looseObject({
          address: z.string(),
          symbol: z.string().nullish(),
          market_cap: z.number().nullish(),
          liquidity: z.number().nullish(),
        }),
      )
      .nullish(),
    tokens: z.array(z.looseObject({ address: z.string() })).nullish(),
  }),
});

export class BirdeyeClient {
  constructor(private readonly http: HttpClient) {}

  /** Solana tokens within a market-cap band, highest liquidity first. */
  async tokensInMarketCapBand(minUsd: number, maxUsd: number, limit = 100): Promise<string[]> {
    const res = await this.http.request({
      path: '/defi/v3/token/list',
      query: {
        sort_by: 'liquidity',
        sort_type: 'desc',
        min_market_cap: Math.floor(minUsd),
        max_market_cap: Math.ceil(maxUsd),
        limit,
      },
      headers: { 'x-chain': 'solana' },
      schema: TokenListSchema,
    });
    const rows = res.data.items ?? res.data.tokens ?? [];
    return [...new Set(rows.map((r) => r.address))];
  }
}
