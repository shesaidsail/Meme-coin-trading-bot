export interface Candidate {
  mint: string;
  symbol: string | null;
  name: string | null;
  /** DexScreener market cap (falls back to FDV). */
  marketCapUsd: number;
  /** The pair with the most liquidity: where our trades will mostly route. */
  primaryPair: {
    address: string;
    dexId: string;
    quoteMint: string;
    liquidityUsd: number | null;
    labels: string[];
  };
  /** Sum of liquidity across all eligible pairs. */
  totalLiquidityUsd: number;
  /** Every pair address for this mint (all are pool accounts, excluded from holder stats). */
  pairAddresses: string[];
  /** Earliest pair creation time across pairs (an upper bound on token creation time). */
  earliestPairCreatedAt: number | null;
  priceUsd: number | null;
  sources: string[];
}
