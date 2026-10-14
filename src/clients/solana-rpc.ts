import { z } from 'zod';
import type { HttpClient } from './http.js';
import type { Priority } from './budget.js';
import { ApiError } from './errors.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Budget weights. Plain reads cost 1. History calls are weighted higher
 * because providers (e.g. Helius) bill them as heavier/archival requests.
 */
const UNITS = { read: 1, history: 10 } as const;

/**
 * Highest transaction version we can parse. Mainnet carries version-1
 * transactions; requesting with 0 makes the RPC reject them (-32015).
 * Versions 0 and 1 share the jsonParsed shape used here (verified live).
 */
export const MAX_TX_VERSION = 1;

const RpcEnvelope = z.looseObject({
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).nullish(),
});

/** JSON-RPC providers report throttling as an error inside a 200 response. */
function isThrottledBody(body: unknown): boolean {
  const code = (body as { error?: { code?: number } } | null)?.error?.code;
  return code === 429 || code === -32429 || code === -32005;
}

const ParsedMint = z.looseObject({
  owner: z.string(),
  data: z.looseObject({
    parsed: z.looseObject({
      type: z.string(),
      info: z.looseObject({
        decimals: z.number(),
        supply: z.string(),
        mintAuthority: z.string().nullish(),
        freezeAuthority: z.string().nullish(),
        extensions: z.array(z.looseObject({ extension: z.string(), state: z.unknown().optional() })).nullish(),
      }),
    }),
  }),
});

export interface MintInfo {
  programId: string;
  isToken2022: boolean;
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Token-2022 extension names as jsonParsed reports them (e.g. "transferFeeConfig"). */
  extensions: string[];
  extensionStates: Record<string, unknown>;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export interface TokenBalance {
  owner: string | null;
  mint: string;
  amount: bigint;
}

export interface ParsedTx {
  slot: number;
  blockTime: number | null;
  failed: boolean;
  feePayer: string | null;
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
}

const TokenBalanceSchema = z.looseObject({
  mint: z.string(),
  owner: z.string().nullish(),
  uiTokenAmount: z.looseObject({ amount: z.string() }),
});

const TxSchema = z
  .looseObject({
    slot: z.number(),
    blockTime: z.number().nullish(),
    meta: z
      .looseObject({
        err: z.unknown().optional(),
        preTokenBalances: z.array(TokenBalanceSchema).nullish(),
        postTokenBalances: z.array(TokenBalanceSchema).nullish(),
      })
      .nullish(),
    transaction: z.looseObject({
      message: z.looseObject({
        accountKeys: z.array(z.union([z.string(), z.looseObject({ pubkey: z.string() })])),
      }),
    }),
  })
  .nullable();

/** How long a method is skipped after it stays rate limited through its retries. */
export const METHOD_COOLDOWN_MS = 10 * 60_000;

export class SolanaRpcClient {
  private id = 0;
  /**
   * Per-method circuit breaker. Some RPC tiers block specific methods outright
   * (the public mainnet RPC answers getTokenLargestAccounts with
   * x-ratelimit-method-limit: 0), so retrying them only wastes time and budget.
   */
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly http: HttpClient,
    private readonly now: () => number = Date.now,
  ) {}

  async call<T>(
    method: string,
    params: unknown[],
    schema: z.ZodType<T>,
    opts: { units?: number; priority?: Priority; maxRetries?: number } = {},
  ): Promise<T> {
    const until = this.cooldownUntil.get(method) ?? 0;
    if (this.now() < until) {
      throw new ApiError(this.http.name, 'rate_limited', `${method} is cooling down after repeated rate limiting (until ${new Date(until).toISOString()})`, 429);
    }
    let env;
    try {
      env = await this.http.request({
        path: '',
        method: 'POST',
        body: { jsonrpc: '2.0', id: ++this.id, method, params },
        schema: RpcEnvelope,
        units: opts.units ?? UNITS.read,
        priority: opts.priority ?? 'normal',
        isThrottledBody,
        endpoint: `rpc:${method}`,
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      });
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'rate_limited') this.cooldownUntil.set(method, this.now() + METHOD_COOLDOWN_MS);
      throw e;
    }
    if (env.error) {
      throw new ApiError(this.http.name, 'http', `${method}: RPC error ${env.error.code} ${env.error.message}`, 200, env.error);
    }
    const parsed = schema.safeParse(env.result);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ApiError(this.http.name, 'schema', `${method}: unexpected result: ${issue?.path.join('.')} ${issue?.message}`);
    }
    return parsed.data;
  }

  /** Mint account, parsed by the RPC (handles both SPL Token and Token-2022). Null if it does not exist. */
  async getMintInfo(mint: string): Promise<MintInfo | null> {
    const res = await this.call(
      'getAccountInfo',
      [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      z.looseObject({ value: ParsedMint.nullable() }),
    );
    const v = res.value;
    if (!v) return null;
    if (v.data.parsed.type !== 'mint') {
      throw new ApiError(this.http.name, 'schema', `${mint} is not a mint account (${v.data.parsed.type})`);
    }
    const info = v.data.parsed.info;
    const exts = info.extensions ?? [];
    return {
      programId: v.owner,
      isToken2022: v.owner === TOKEN_2022_PROGRAM,
      decimals: info.decimals,
      supply: BigInt(info.supply),
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      extensions: exts.map((e) => e.extension),
      extensionStates: Object.fromEntries(exts.map((e) => [e.extension, e.state ?? null])),
    };
  }

  async getTokenSupply(mint: string): Promise<bigint> {
    const res = await this.call('getTokenSupply', [mint], z.looseObject({ value: z.looseObject({ amount: z.string() }) }));
    return BigInt(res.value.amount);
  }

  /**
   * Top 20 token accounts by balance. The public mainnet RPC blocks this
   * method; callers fall back to RugCheck, so it is not retried.
   */
  async getTokenLargestAccounts(mint: string): Promise<{ address: string; amount: bigint }[]> {
    const res = await this.call(
      'getTokenLargestAccounts',
      [mint, { commitment: 'confirmed' }],
      z.looseObject({ value: z.array(z.looseObject({ address: z.string(), amount: z.string() })) }),
      { maxRetries: 0 },
    );
    return res.value.map((a) => ({ address: a.address, amount: BigInt(a.amount) }));
  }

  /** Owner wallet of each token account (null for missing or non-token accounts). */
  async getTokenAccountOwners(addresses: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const res = await this.call(
        'getMultipleAccounts',
        [chunk, { encoding: 'jsonParsed', commitment: 'confirmed' }],
        z.looseObject({
          value: z.array(
            z
              .looseObject({
                data: z.union([
                  z.looseObject({ parsed: z.looseObject({ info: z.looseObject({ owner: z.string().optional() }) }) }),
                  z.unknown(),
                ]),
              })
              .nullable(),
          ),
        }),
      );
      chunk.forEach((addr, j) => {
        const acc = res.value[j];
        const owner = (acc?.data as { parsed?: { info?: { owner?: string } } } | undefined)?.parsed?.info?.owner;
        out.set(addr, owner ?? null);
      });
    }
    return out;
  }

  async getSignaturesForAddress(address: string, opts: { before?: string; limit?: number } = {}): Promise<SignatureInfo[]> {
    const res = await this.call(
      'getSignaturesForAddress',
      [address, { limit: opts.limit ?? 1000, ...(opts.before ? { before: opts.before } : {}), commitment: 'confirmed' }],
      z.array(
        z.looseObject({
          signature: z.string(),
          slot: z.number(),
          blockTime: z.number().nullish(),
          err: z.unknown().optional(),
        }),
      ),
      { units: UNITS.history },
    );
    return res.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, err: s.err ?? null }));
  }

  async getTransaction(signature: string): Promise<ParsedTx | null> {
    const tx = await this.call(
      'getTransaction',
      [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' }],
      TxSchema,
      { units: UNITS.history },
    );
    if (!tx) return null;
    const bal = (b: z.infer<typeof TokenBalanceSchema>): TokenBalance => ({
      owner: b.owner ?? null,
      mint: b.mint,
      amount: BigInt(b.uiTokenAmount.amount),
    });
    const k0 = tx.transaction.message.accountKeys[0];
    return {
      slot: tx.slot,
      blockTime: tx.blockTime ?? null,
      failed: tx.meta?.err !== undefined && tx.meta?.err !== null,
      feePayer: k0 === undefined ? null : typeof k0 === 'string' ? k0 : k0.pubkey,
      preTokenBalances: (tx.meta?.preTokenBalances ?? []).map(bal),
      postTokenBalances: (tx.meta?.postTokenBalances ?? []).map(bal),
    };
  }
}
