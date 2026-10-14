import type { Config } from '../config/schema.js';
import type { JupiterClient, QuoteResult } from '../clients/jupiter.js';
import type { Priority } from '../clients/budget.js';
import { realSleep, type Sleep } from '../clients/rate-limiter.js';
import { bpsToFraction, mulFrac } from '../util/units.js';
import type { Executor, SwapRequest, SwapResult } from './types.js';

/**
 * Paper executor: real Jupiter quotes, simulated fills.
 *  1. Decision quote at the requested slippage → minimum acceptable output.
 *  2. After `paper.latencyMs`, an execution quote → fill price, minus
 *     `paper.adverseFillBps` (sandwiching / landing delay).
 *  3. Fill below the minimum → slippage failure, fee still paid (as on-chain).
 * No route at decision time fails before "sending", so no fee is charged.
 * Price impact is not a failure: it is already in the quote, and slippage
 * tolerance is measured against the quote.
 */
export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const;

  constructor(
    private readonly deps: { jupiter: Pick<JupiterClient, 'quote'>; config: Config; sleep?: Sleep },
  ) {}

  buy(mint: string, req: SwapRequest): Promise<SwapResult> {
    return this.swap(this.deps.config.chain.solMint, mint, req, 'normal');
  }

  sell(mint: string, req: SwapRequest): Promise<SwapResult> {
    return this.swap(mint, this.deps.config.chain.solMint, req, 'critical');
  }

  private async swap(inputMint: string, outputMint: string, req: SwapRequest, priority: Priority): Promise<SwapResult> {
    const { config } = this.deps;
    const fee = BigInt(config.costs.priorityFeeLamports);
    const fail = (failure: SwapResult['failure'], error: string, extra: Partial<SwapResult> = {}): SwapResult => ({
      status: 'failed',
      failure,
      error,
      inFilled: 0n,
      out: 0n,
      quotedOut: null,
      priceImpact: null,
      feeLamports: 0n,
      signature: null,
      ...extra,
    });

    let decision: QuoteResult;
    try {
      decision = await this.deps.jupiter.quote({ inputMint, outputMint, amount: req.amount, slippageBps: req.slippageBps, priority });
    } catch (e) {
      return fail('error', `quote failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!decision.ok) return fail('no_route', `${decision.reason}: ${decision.message}`);
    const q1 = decision.quote;

    await (this.deps.sleep ?? realSleep)(config.paper.latencyMs);

    let exec: QuoteResult;
    try {
      exec = await this.deps.jupiter.quote({ inputMint, outputMint, amount: req.amount, slippageBps: req.slippageBps, priority });
    } catch (e) {
      // The transaction was "sent" based on q1; an unknown outcome is treated as a failed tx that paid its fee.
      return fail('error', `execution quote failed: ${e instanceof Error ? e.message : String(e)}`, { quotedOut: q1.outAmount, feeLamports: fee });
    }
    if (!exec.ok) return fail('no_route', `route vanished before execution: ${exec.message}`, { quotedOut: q1.outAmount, feeLamports: fee });

    const filled = mulFrac(exec.quote.outAmount, 1 - bpsToFraction(config.paper.adverseFillBps));
    if (filled < q1.minOutAmount) {
      return fail('slippage', `fill ${filled} below minimum ${q1.minOutAmount} at ${req.slippageBps}bps`, {
        quotedOut: q1.outAmount,
        priceImpact: q1.priceImpact,
        feeLamports: fee,
      });
    }
    return {
      status: 'filled',
      inFilled: req.amount,
      out: filled,
      quotedOut: q1.outAmount,
      priceImpact: exec.quote.priceImpact,
      feeLamports: fee,
      signature: null,
    };
  }
}
