import { z } from 'zod';
import type { HttpClient } from './http.js';
import type { Priority } from './budget.js';
import { ApiError } from './errors.js';

const QuoteSchema = z.looseObject({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: z.string(),
  outAmount: z.string(),
  otherAmountThreshold: z.string(),
  slippageBps: z.number(),
  /** A FRACTION despite the name (verified: 50 SOL into a ~219 SOL pool → "0.186"). */
  priceImpactPct: z.string(),
  routePlan: z.array(
    z.looseObject({
      swapInfo: z.looseObject({
        ammKey: z.string(),
        label: z.string().nullish(),
      }),
      percent: z.number().nullish(),
    }),
  ),
  contextSlot: z.number().optional(),
});

export interface Quote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  /** Expected output, after pool fees and price impact. */
  outAmount: bigint;
  /** Minimum output at the requested slippage. */
  minOutAmount: bigint;
  /** Price impact as a fraction (0.02 = 2%). */
  priceImpact: number;
  slippageBps: number;
  routeLabels: string[];
  ammKeys: string[];
  contextSlot: number | null;
  /** Raw response, needed later to build the swap transaction. */
  raw: unknown;
}

export type QuoteResult =
  | { ok: true; quote: Quote }
  | { ok: false; reason: 'no_route' | 'not_tradable'; message: string };

const NO_ROUTE_CODES = new Set(['COULD_NOT_FIND_ANY_ROUTE', 'NO_ROUTES_FOUND', 'ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT']);
const NOT_TRADABLE_CODES = new Set(['TOKEN_NOT_TRADABLE', 'CIRCULAR_ARBITRAGE_IS_DISABLED']);

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  priority?: Priority;
}

export class JupiterClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * Gets an ExactIn quote. "No route" / "not tradable" are returned as values
   * (they are answers, not failures); transport problems throw ApiError.
   */
  async quote(req: QuoteRequest): Promise<QuoteResult> {
    if (req.amount <= 0n) throw new RangeError('quote amount must be positive');
    try {
      const q = await this.http.request({
        path: '/quote',
        query: {
          inputMint: req.inputMint,
          outputMint: req.outputMint,
          amount: req.amount.toString(),
          slippageBps: req.slippageBps,
          swapMode: 'ExactIn',
        },
        schema: QuoteSchema,
        priority: req.priority ?? 'normal',
      });
      const impact = Number(q.priceImpactPct);
      return {
        ok: true,
        quote: {
          inputMint: q.inputMint,
          outputMint: q.outputMint,
          inAmount: BigInt(q.inAmount),
          outAmount: BigInt(q.outAmount),
          minOutAmount: BigInt(q.otherAmountThreshold),
          priceImpact: Number.isFinite(impact) ? Math.abs(impact) : 0,
          slippageBps: q.slippageBps,
          routeLabels: q.routePlan.map((r) => r.swapInfo.label ?? 'unknown'),
          ammKeys: q.routePlan.map((r) => r.swapInfo.ammKey),
          contextSlot: q.contextSlot ?? null,
          raw: q,
        },
      };
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'http' && e.status !== undefined && e.status >= 400 && e.status < 500) {
        const body = (e.body ?? {}) as { errorCode?: string; error?: string };
        const code = body.errorCode ?? '';
        const message = body.error ?? e.message;
        if (NOT_TRADABLE_CODES.has(code)) return { ok: false, reason: 'not_tradable', message };
        if (NO_ROUTE_CODES.has(code) || /route/i.test(message)) return { ok: false, reason: 'no_route', message };
      }
      throw e;
    }
  }

  /** SOL price in USD, from a 1 SOL → USDC quote. */
  async solUsd(solMint: string, usdcMint: string, priority: Priority = 'normal'): Promise<number> {
    const r = await this.quote({ inputMint: solMint, outputMint: usdcMint, amount: 1_000_000_000n, slippageBps: 50, priority });
    if (!r.ok) throw new ApiError(this.http.name, 'http', `cannot price SOL: ${r.message}`);
    return Number(r.quote.outAmount) / 1e6;
  }
}
