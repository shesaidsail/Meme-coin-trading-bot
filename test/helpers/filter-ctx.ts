import { readFileSync } from 'node:fs';
import { TokenContext } from '../../src/filters/context.js';
import { buildCandidate } from '../../src/scanner/scanner.js';
import type { Candidate } from '../../src/scanner/types.js';
import type { DexPair } from '../../src/clients/dexscreener.js';
import type { RugcheckReport } from '../../src/clients/rugcheck.js';
import type { MintInfo, ParsedTx, SignatureInfo } from '../../src/clients/solana-rpc.js';
import type { Quote, QuoteResult } from '../../src/clients/jupiter.js';
import { FakeClock } from '../../src/util/clock.js';
import { testConfig, NOW } from './deps.js';

export const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(`test/fixtures/${name}`, 'utf8')) as T;

/** ABU: a real pump.fun → PumpSwap token that passed every filter on live data. */
export const ABU_MINT = '6hTLdzZaaCjmqtn7RtaEMQsCbXT5Pg8q76tRViEGpump';
export const SOL = 'So11111111111111111111111111111111111111112';

export function cleanReport(): RugcheckReport {
  return fixture<RugcheckReport>('rugcheck-report-pumpswap-clean.json');
}

/** Mint info for ABU, decoded from the captured getAccountInfo response. */
export function abuMintInfo(): MintInfo {
  const v = fixture<{ result: { value: { owner: string; data: { parsed: { info: { decimals: number; supply: string; extensions: { extension: string }[] } } } } } }>(
    'rpc-mint-token2022.json',
  ).result.value;
  const info = v.data.parsed.info;
  return {
    programId: v.owner,
    isToken2022: true,
    decimals: info.decimals,
    supply: BigInt(info.supply),
    mintAuthority: null,
    freezeAuthority: null,
    extensions: info.extensions.map((e) => e.extension),
    extensionStates: {},
  };
}

export function abuCandidate(over: Partial<Candidate> = {}): Candidate {
  const pairs = fixture<DexPair[]>('dexscreener-tokens.json').filter((p) => p.baseToken.address === ABU_MINT);
  const c = buildCandidate(ABU_MINT, pairs, testConfig(), ['test']);
  if (typeof c === 'string') throw new Error(c);
  return { ...c, ...over };
}

export function quote(inputMint: string, outputMint: string, inAmount: bigint, outAmount: bigint, priceImpact = 0.01): QuoteResult {
  const q: Quote = {
    inputMint,
    outputMint,
    inAmount,
    outAmount,
    minOutAmount: (outAmount * 97n) / 100n,
    priceImpact,
    slippageBps: 300,
    routeLabels: ['Pump.fun Amm'],
    ammKeys: ['pool'],
    contextSlot: 1,
    raw: {},
  };
  return { ok: true, quote: q };
}

type Stub<T> = T | Error | (() => T | Promise<T>);
const resolve = async <T>(s: Stub<T>): Promise<T> => {
  if (s instanceof Error) throw s;
  return typeof s === 'function' ? (s as () => T | Promise<T>)() : s;
};

export interface CtxOptions {
  candidate?: Partial<Candidate>;
  config?: unknown;
  now?: number;
  sizeLamports?: bigint;
  report?: Stub<RugcheckReport | null>;
  mint?: Stub<MintInfo | null>;
  largest?: Stub<{ address: string; amount: bigint }[]>;
  owners?: Stub<Map<string, string | null>>;
  lpSupply?: Stub<bigint>;
  /** Pages returned in order by getSignaturesForAddress. */
  signatures?: Stub<SignatureInfo[][]>;
  txs?: Record<string, ParsedTx>;
  buy?: Stub<QuoteResult>;
  sell?: Stub<QuoteResult>;
}

/**
 * A TokenContext over stubbed clients. Defaults are ABU's real captured
 * data with the conditions seen on the public RPC: largest-accounts blocked
 * (holders fall back to RugCheck) and a history too long for launch analysis.
 */
export function makeCtx(o: CtxOptions = {}) {
  const config = testConfig(o.config);
  const size = o.sizeLamports ?? 500_000_000n;
  const calls: string[] = [];
  const quoteRequests: { inputMint: string; outputMint: string; amount: bigint }[] = [];
  let sigPage = 0;
  const rpc = {
    getMintInfo: async () => (calls.push('getMintInfo'), resolve(o.mint ?? abuMintInfo())),
    getTokenSupply: async () => (calls.push('getTokenSupply'), resolve(o.lpSupply ?? 0n)),
    getTokenLargestAccounts: async () => (calls.push('getTokenLargestAccounts'), resolve(o.largest ?? new Error('rpc: rate limited on rpc:getTokenLargestAccounts'))),
    getTokenAccountOwners: async () => (calls.push('getTokenAccountOwners'), resolve(o.owners ?? new Map())),
    getSignaturesForAddress: async () => {
      calls.push('getSignaturesForAddress');
      const pages = await resolve(o.signatures ?? [Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, slot: 1000 - i, blockTime: null, err: null }))]);
      return pages[Math.min(sigPage++, pages.length - 1)] ?? [];
    },
    getTransaction: async (sig: string) => (calls.push(`getTransaction:${sig}`), o.txs?.[sig] ?? null),
  };
  const rugcheck = { report: async () => (calls.push('rugcheck'), resolve(o.report === undefined ? cleanReport() : o.report)) };
  const jupiter = {
    quote: async (req: { inputMint: string; outputMint: string; amount: bigint }) => {
      calls.push(`quote:${req.inputMint === SOL ? 'buy' : 'sell'}`);
      quoteRequests.push({ inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amount });
      if (req.inputMint === SOL) return resolve(o.buy ?? quote(SOL, ABU_MINT, req.amount, 224_888_830_478n, 0.02));
      return resolve(o.sell ?? quote(ABU_MINT, SOL, req.amount, (size * 973n) / 1000n, 0.002));
    },
  };
  const ctx = new TokenContext(abuCandidate(o.candidate), {
    config,
    clients: { rpc, rugcheck, jupiter } as never,
    clock: new FakeClock(o.now ?? NOW),
    intendedSizeLamports: size,
  });
  return { ctx, calls, quoteRequests, config };
}
