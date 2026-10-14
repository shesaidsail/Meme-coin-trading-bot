import type { Mode } from '../storage/types.js';

export type FailureKind = 'no_route' | 'slippage' | 'error';

export interface SwapRequest {
  /** Input amount in raw units (lamports for buys, token units for sells). */
  amount: bigint;
  slippageBps: number;
}

export interface SwapResult {
  status: 'filled' | 'failed';
  failure?: FailureKind;
  error?: string;
  /** Input actually consumed (0 on failure). Swaps are atomic: all or nothing. */
  inFilled: bigint;
  /** Output received (0 on failure). */
  out: bigint;
  /** Output of the quote the order was based on. */
  quotedOut: bigint | null;
  priceImpact: number | null;
  /** Fees paid in lamports (charged even when a transaction fails on-chain). */
  feeLamports: bigint;
  signature: string | null;
}

export interface Executor {
  readonly mode: Mode;
  buy(mint: string, req: SwapRequest): Promise<SwapResult>;
  sell(mint: string, req: SwapRequest): Promise<SwapResult>;
}
