import { z } from 'zod';

/**
 * Single source of truth for every tunable. Defaults here must match
 * config/config.yaml (enforced by a test) so the YAML file documents reality.
 *
 * Note on zod 4: `.prefault({})` (not `.default({})`) is used for nested
 * objects so the default is itself parsed and inner defaults are applied.
 */

const fraction = z.number().min(0).max(1);
const positiveInt = z.number().int().positive();
const nonNegInt = z.number().int().nonnegative();

/** What a filter does when its data source returns nothing usable. */
export const MissingDataPolicy = z.enum(['reject', 'skip', 'warn']);
export type MissingDataPolicy = z.infer<typeof MissingDataPolicy>;

const filterBase = {
  enabled: z.boolean().default(true),
  /**
   * reject: token fails, recorded as `insufficient_data` (default).
   * skip:   filter is ignored for this token, recorded as `skipped`.
   * warn:   filter passes, recorded as `warn` so it shows in the report.
   */
  onMissingData: MissingDataPolicy.default('reject'),
};

/** Well-known burn / null addresses excluded from holder concentration. */
export const DEFAULT_EXCLUDED_HOLDERS = [
  '1nc1nerator11111111111111111111111111111111', // incinerator
  '11111111111111111111111111111111', // system program / null
  '5Q544fKrFoe6tsEbD7S8EWxGZXHw4EjVbG6gdT6HmS3', // Raydium AMM v4 authority (pool vaults)
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM authority (pool vaults)
];

const FiltersSchema = z.object({
  mintAuthority: z.object({ ...filterBase }).prefault({}),
  freezeAuthority: z.object({ ...filterBase }).prefault({}),
  lpLocked: z
    .object({
      ...filterBase,
      /** Fraction of LP supply that must be burned or held by a known locker. */
      minBurnedOrLockedFraction: fraction.default(0.95),
    })
    .prefault({}),
  liquidity: z
    .object({
      ...filterBase,
      minLiquidityUsd: z.number().nonnegative().default(40_000),
      /** liquidity_usd / market_cap_usd */
      minLiquidityToMcap: fraction.default(0.1),
    })
    .prefault({}),
  holderConcentration: z
    .object({
      ...filterBase,
      /** Top 10 non-LP, non-burn holders combined, as fraction of supply. */
      maxTop10Fraction: fraction.default(0.3),
      /** Largest single non-LP wallet, as fraction of supply. */
      maxSingleWalletFraction: fraction.default(0.05),
      /**
       * Owners excluded from concentration (burn addresses, AMM vault authorities).
       * Pool accounts detected from DexScreener/RugCheck are excluded automatically.
       */
      excludeAddresses: z.array(z.string()).default(DEFAULT_EXCLUDED_HOLDERS),
    })
    .prefault({}),
  devWallet: z
    .object({
      ...filterBase,
      maxDevHoldingFraction: fraction.default(0.05),
      /** Reject if the creator has sold more than this fraction of their initial allocation. */
      maxDevSoldFraction: fraction.default(0.5),
      rejectPriorRugs: z.boolean().default(true),
    })
    .prefault({}),
  honeypot: z
    .object({
      ...filterBase,
      /** Max price impact of a sell quote sized like our intended position. */
      maxSellPriceImpact: fraction.default(0.1),
      /**
       * Max loss on a quoted buy→sell round trip sized like our position
       * (includes pool fees and price impact on both sides). Catches sell
       * taxes and asymmetric pools that a one-sided impact check misses.
       */
      maxRoundTripLoss: fraction.default(0.15),
    })
    .prefault({}),
  token2022: z
    .object({
      ...filterBase,
      /**
       * Token-2022 extensions considered harmless, by their RPC jsonParsed
       * names. Any other extension (transferFeeConfig, transferHook,
       * permanentDelegate, nonTransferable, defaultAccountState, pausableConfig,
       * confidentialTransferMint, ...) rejects the token. Note that
       * transferFeeConfig is rejected even at 0% because its authority can raise it.
       */
      allowedExtensions: z.array(z.string()).default(['metadataPointer', 'tokenMetadata']),
    })
    .prefault({}),
  bundledLaunch: z
    .object({
      ...filterBase,
      /** Number of slots from pool creation treated as "launch". */
      launchSlots: positiveInt.default(2),
      /** Max fraction of supply bought in the launch slots by non-pool wallets (on-chain check). */
      maxLaunchBuyFraction: fraction.default(0.2),
      /** Max fraction of supply currently held by top holders RugCheck flags as insiders. */
      maxInsiderHeldFraction: fraction.default(0.15),
      /**
       * Max token amount of RugCheck's largest linked-wallet network, as a
       * fraction of supply. RugCheck reports this as tokenAmount/currentHolding
       * but live data shows values far above what the top holders could hold
       * (e.g. 98.9% for a 32-wallet network), so it is treated as "supply that
       * moved through linked wallets", a bundling signal. Calibrate from paper data.
       */
      maxLinkedNetworkFraction: fraction.default(0.5),
      /**
       * Pages (1000 signatures each) to walk back through the mint's history
       * looking for its launch. Busy tokens exceed this and fall back to
       * RugCheck insider data only. Each page and each launch tx costs RPC budget.
       */
      maxSignaturePages: positiveInt.default(3),
      /** Max launch-slot transactions fetched for the on-chain check. */
      maxLaunchTransactions: positiveInt.default(40),
    })
    .prefault({}),
  tokenAge: z
    .object({
      ...filterBase,
      minAgeMinutes: z.number().nonnegative().default(30),
    })
    .prefault({}),
  holderCount: z
    .object({
      ...filterBase,
      minHolders: nonNegInt.default(200),
    })
    .prefault({}),
  rugcheckScore: z
    .object({
      ...filterBase,
      /**
       * RugCheck's normalised score is a RISK score: 0 = safest, 100 = riskiest.
       * Tokens with a score above this are rejected.
       */
      maxNormalisedRiskScore: z.number().min(0).max(100).default(30),
      /** Also reject if RugCheck lists any risk with level "danger". */
      rejectOnDangerRisks: z.boolean().default(true),
    })
    .prefault({}),
});
export type FiltersConfig = z.infer<typeof FiltersSchema>;
export type FilterName = keyof FiltersConfig;

const ApiSchema = (d: {
  baseUrl: string;
  maxPerSecond: number;
  maxPerMinute: number;
  budgetUnitsPerDay: number;
}) =>
  z
    .object({
      baseUrl: z.string().url().default(d.baseUrl),
      timeoutMs: positiveInt.default(10_000),
      maxRetries: nonNegInt.default(3),
      rateLimit: z
        .object({
          maxPerSecond: z.number().positive().default(d.maxPerSecond),
          maxPerMinute: z.number().positive().default(d.maxPerMinute),
        })
        .prefault({}),
      budget: z
        .object({
          /**
           * Daily call budget in provider "units" (1 per call unless the
           * client assigns a heavier weight, e.g. Helius enhanced APIs).
           * Resets at 00:00 UTC. Persisted, so restarts don't reset it.
           */
          unitsPerDay: positiveInt.default(d.budgetUnitsPerDay),
          /**
           * Fraction of the daily budget reserved for critical calls
           * (exit quotes and sells). Scanning stops once only the reserve is left.
           */
          reserveFraction: fraction.default(0.25),
        })
        .prefault({}),
    })
    .prefault({});

export const ConfigSchema = z
  .object({
    /** "paper" (default) or "live". Live requires WALLET_PRIVATE_KEY in .env. */
    mode: z.enum(['paper', 'live']).default('paper'),

    paper: z
      .object({
        startingSol: z.number().positive().default(10),
      })
      .prefault({}),

    chain: z
      .object({
        solMint: z.string().default('So11111111111111111111111111111111111111112'),
        usdcMint: z.string().default('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      })
      .prefault({}),

    universe: z
      .object({
        minMarketCapUsd: z.number().nonnegative().default(150_000),
        maxMarketCapUsd: z.number().positive().default(600_000),
        /** Candidates closest to this market cap are evaluated first. */
        targetMarketCapUsd: z.number().positive().default(300_000),
      })
      .prefault({}),

    strategy: z
      .object({
        /** Each entry is this fraction of current equity (sellable-value basis). */
        positionSizeFraction: fraction.default(0.05),
        maxOpenPositions: positiveInt.default(10),
        /** Deployed capital (at sellable value) may never exceed this fraction of equity. */
        maxDeployedFraction: fraction.default(0.5),
        /** Net multiple of cost basis targeted after all costs. 2.5 = +150%. */
        targetNetMultiplier: z.number().gt(1).default(2.5),
        timeStopHours: z.number().positive().default(48),
        stopLoss: z
          .object({
            /** Off by default. When off, it is still evaluated and logged ("shadow"). */
            enabled: z.boolean().default(false),
            /** Exit when sellable value falls this fraction below cost basis. */
            lossFraction: fraction.default(0.5),
          })
          .prefault({}),
        /** Consecutive failed sell quotes before a position is flagged "unquotable". */
        unquotableAfterFailures: positiveInt.default(3),
      })
      .prefault({}),

    costs: z
      .object({
        /** Platform/referral fee charged on top of the route, in bps. Jupiter itself charges none. */
        swapFeeBps: nonNegInt.default(0),
        /** Priority fee + base fee per swap transaction, in lamports. */
        priorityFeeLamports: nonNegInt.default(100_000),
        /** Expected slippage beyond the quoted price impact, in bps, per side. */
        expectedSlippageBps: nonNegInt.default(100),
        /** Rent for creating the token account on buy (refunded on close after full exit). */
        ataRentLamports: nonNegInt.default(2_039_280),
      })
      .prefault({}),

    execution: z
      .object({
        buySlippageBps: positiveInt.default(300),
        sell: z
          .object({
            initialSlippageBps: positiveInt.default(300),
            slippageStepBps: positiveInt.default(300),
            maxSlippageBps: positiveInt.default(2_000),
            maxAttempts: positiveInt.default(6),
            retryDelayMs: nonNegInt.default(2_000),
          })
          .prefault({}),
      })
      .prefault({}),

    loop: z
      .object({
        scanIntervalSec: positiveInt.default(60),
        monitorIntervalSec: positiveInt.default(30),
        maxCandidatesPerScan: positiveInt.default(20),
      })
      .prefault({}),

    scanner: z
      .object({
        /** Discovery sources. Birdeye is used only when BIRDEYE_API_KEY is set. */
        sources: z
          .object({
            dexscreenerProfiles: z.boolean().default(true),
            dexscreenerBoosts: z.boolean().default(true),
            dexscreenerTakeovers: z.boolean().default(true),
            dexscreenerAds: z.boolean().default(true),
            rugcheckNewTokens: z.boolean().default(true),
            rugcheckRecent: z.boolean().default(true),
            rugcheckTrending: z.boolean().default(true),
            birdeye: z.boolean().default(true),
          })
          .prefault({}),
        /**
         * DexScreener dexIds that are skipped. "pumpfun" is the pre-migration
         * bonding curve: there is no LP to verify and no liquidity figure.
         */
        excludeDexIds: z.array(z.string()).default(['pumpfun']),
        /** Watchlisted mints are re-priced at most this often. */
        recheckCooldownMinutes: z.number().positive().default(10),
        /** Watchlisted mints are dropped this long after first being seen. */
        watchExpiryHours: z.number().positive().default(72),
        /** Max watchlist mints re-priced per scan (DexScreener takes 30 per call). */
        maxPricedPerScan: positiveInt.default(150),
        /** A mint that went through the filter pipeline is not re-evaluated for this long. */
        reevaluateCooldownMinutes: z.number().nonnegative().default(60),
        /**
         * Real-time pool-creation discovery over the RPC WebSocket (Helius free
         * tier works). Tokens are priced only once pool creation + the minimum
         * token age has passed.
         */
        poolListener: z
          .object({
            enabled: z.boolean().default(true),
            /** pump.fun graduations to PumpSwap (via the pump.fun migration authority). */
            pumpGraduations: z.boolean().default(true),
            /** Raydium CPMM pool creations, including Raydium LaunchLab graduations. */
            raydiumCpmm: z.boolean().default(true),
            /** Cap on transactions resolved per hour (one getTransaction each). */
            maxResolvesPerHour: positiveInt.default(400),
            /** On (re)connect, catch up on at most this many missed signatures per feed. */
            backfillLimit: nonNegInt.default(50),
            /** Reconnect if no message arrives for this long. */
            idleReconnectMinutes: z.number().positive().default(10),
            reconnectMaxDelaySec: positiveInt.default(60),
          })
          .prefault({}),
      })
      .prefault({}),

    pipeline: z
      .object({
        /**
         * Stop at the first rejecting filter (saves API budget; later filters
         * get no result for that token). false = run all filters on every
         * candidate for fuller statistics.
         */
        stopOnFirstReject: z.boolean().default(true),
      })
      .prefault({}),

    filters: FiltersSchema.prefault({}),

    apis: z
      .object({
        jupiter: ApiSchema({
          baseUrl: 'https://lite-api.jup.ag/swap/v1',
          maxPerSecond: 1,
          maxPerMinute: 50,
          budgetUnitsPerDay: 50_000,
        }),
        dexscreener: ApiSchema({
          baseUrl: 'https://api.dexscreener.com',
          maxPerSecond: 2,
          maxPerMinute: 50,
          budgetUnitsPerDay: 40_000,
        }),
        rugcheck: ApiSchema({
          baseUrl: 'https://api.rugcheck.xyz/v1',
          maxPerSecond: 2,
          maxPerMinute: 30,
          budgetUnitsPerDay: 5_000,
        }),
        /** RPC URL itself comes from SOLANA_RPC_URL in .env (it embeds the API key). */
        rpc: ApiSchema({
          baseUrl: 'https://api.mainnet-beta.solana.com',
          maxPerSecond: 8,
          maxPerMinute: 300,
          budgetUnitsPerDay: 30_000,
        }),
        /** Only used when BIRDEYE_API_KEY is set. */
        birdeye: ApiSchema({
          baseUrl: 'https://public-api.birdeye.so',
          maxPerSecond: 1,
          maxPerMinute: 30,
          budgetUnitsPerDay: 1_000,
        }),
      })
      .prefault({}),

    storage: z
      .object({
        path: z.string().default('data/bot.db'),
      })
      .prefault({}),

    killSwitchFile: z.string().default('data/KILL'),

    logging: z
      .object({
        level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
        /**
         * Rate-limit response headers are stored per provider at most this
         * often (every 429 is always stored). See `bot api-usage`.
         */
        rateHeaderSampleSec: positiveInt.default(60),
      })
      .prefault({}),
  })
  .superRefine((c, ctx) => {
    const u = c.universe;
    if (u.minMarketCapUsd >= u.maxMarketCapUsd) {
      ctx.addIssue({
        code: 'custom',
        path: ['universe', 'minMarketCapUsd'],
        message: 'minMarketCapUsd must be below maxMarketCapUsd',
      });
    }
    if (u.targetMarketCapUsd < u.minMarketCapUsd || u.targetMarketCapUsd > u.maxMarketCapUsd) {
      ctx.addIssue({
        code: 'custom',
        path: ['universe', 'targetMarketCapUsd'],
        message: 'targetMarketCapUsd must lie within [minMarketCapUsd, maxMarketCapUsd]',
      });
    }
    if (c.strategy.positionSizeFraction > c.strategy.maxDeployedFraction) {
      ctx.addIssue({
        code: 'custom',
        path: ['strategy', 'positionSizeFraction'],
        message: 'positionSizeFraction cannot exceed maxDeployedFraction',
      });
    }
    const s = c.execution.sell;
    if (s.initialSlippageBps > s.maxSlippageBps) {
      ctx.addIssue({
        code: 'custom',
        path: ['execution', 'sell', 'initialSlippageBps'],
        message: 'initialSlippageBps cannot exceed maxSlippageBps',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type ApiName = keyof Config['apis'];
