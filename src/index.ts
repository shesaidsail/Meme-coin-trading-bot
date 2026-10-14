#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, ConfigError } from './config/load.js';
import { Storage, StorageError } from './storage/store.js';
import { systemClock } from './util/clock.js';
import { solToLamports, formatSol, mulFrac } from './util/units.js';
import { createLogger } from './util/logger.js';
import pino from 'pino';
import { createClients } from './clients/index.js';
import { Scanner, buildCandidate } from './scanner/scanner.js';
import { PoolListener, toWsUrl } from './scanner/pool-listener.js';
import type { Candidate } from './scanner/types.js';
import { randomUUID } from 'node:crypto';
import { evaluateCandidates } from './engine/evaluate.js';
import { ALL_FILTERS } from './filters/index.js';
import { apiUsageReport, evaluationsReport, filterOutcomeReport, rugcheckScoreDistribution, sourcesReport } from './cli/reports.js';

const program = new Command()
  .name('bot')
  .description('Solana memecoin trading bot (paper mode by default)')
  .option('-c, --config <path>', 'config file', 'config/config.yaml')
  .option('-e, --env <path>', '.env file', '.env');

function load() {
  const o = program.opts<{ config: string; env: string }>();
  return loadConfig({ configPath: o.config, envPath: o.env });
}

program
  .command('config')
  .description('validate the config and print the effective settings (secrets are never printed)')
  .action(() => {
    const { config, secrets } = load();
    console.log(JSON.stringify(config, null, 2));
    console.log('\nSecrets present:');
    for (const [k, v] of Object.entries(secrets)) console.log(`  ${k}: ${v ? 'yes' : 'no'}`);
  });

program
  .command('init')
  .description('create the database and seed the paper starting balance')
  .action(() => {
    const { config } = load();
    const store = Storage.open({ path: config.storage.path, mode: config.mode, clock: systemClock });
    try {
      if (config.mode === 'paper') {
        const created = store.ledger.initialise(solToLamports(config.paper.startingSol), systemClock.now());
        console.log(
          created
            ? `Initialised paper account with ${formatSol(store.ledger.balance())} at ${config.storage.path}`
            : `Already initialised: cash ${formatSol(store.ledger.balance())} at ${config.storage.path}`,
        );
      } else {
        console.log(`Live database ready at ${config.storage.path}`);
      }
    } finally {
      store.close();
    }
  });

/** Opens storage and clients; logs go to stderr so command output stays readable. */
function boot() {
  const { config, secrets } = load();
  const logger = createLogger({ level: config.logging.level }, pino.destination(2));
  const storage = Storage.open({ path: config.storage.path, mode: config.mode, clock: systemClock });
  if (config.mode === 'paper') storage.ledger.initialise(solToLamports(config.paper.startingSol), systemClock.now());
  const clients = createClients({ config, secrets, storage, clock: systemClock, logger });
  return { config, secrets, logger, storage, clients };
}

program
  .command('scan')
  .description('run one discovery scan and the filter pipeline (records results; never trades)')
  .option('--all-filters', 'run every filter on every candidate (fuller stats, more API calls)')
  .option('--limit <n>', 'max candidates to evaluate', (v) => Number.parseInt(v, 10))
  .action(async (opts: { allFilters?: boolean; limit?: number }) => {
    const { config, logger, storage, clients } = boot();
    try {
      const scanner = new Scanner({ config, clients, storage, clock: systemClock, logger });
      const stats = await scanner.scan();
      console.log(`Scan ${stats.scanId}`);
      console.log(`  discovered: ${JSON.stringify(stats.discovered)}${Object.keys(stats.sourceErrors).length ? `  errors: ${JSON.stringify(stats.sourceErrors)}` : ''}`);
      console.log(`  new on watchlist: ${stats.newMints} (watchlist ${storage.watchlist.count()}), priced: ${stats.priced}, in band: ${stats.inBand}`);
      console.log(`  dropped before filters: ${JSON.stringify(stats.dropped)}`);
      const candidates = opts.limit ? stats.candidates.slice(0, opts.limit) : stats.candidates;
      if (!candidates.length) {
        console.log('\nNo candidates this scan.');
        return;
      }
      // Step 3 replaces this with the risk module's equity-based size.
      const size = mulFrac(storage.ledger.balance(), config.strategy.positionSizeFraction);
      console.log(`\nEvaluating ${candidates.length} candidate(s); honeypot quotes sized at ${formatSol(size)}${opts.allFilters ? ', all filters' : ''}...\n`);
      const { evaluations, budgetExhausted } = await evaluateCandidates(
        candidates,
        stats.scanId,
        size,
        { config, clients, storage, clock: systemClock, logger, filters: ALL_FILTERS },
        opts.allFilters ? { stopOnFirstReject: false } : {},
      );
      console.log(evaluationsReport(evaluations));
      if (budgetExhausted) console.log(`\nStopped early: ${budgetExhausted}`);
      console.log('\nRugCheck normalised risk score (0 = safest, 100 = riskiest) in this batch:');
      console.log(await rugcheckScoreDistribution(evaluations));
    } finally {
      storage.close();
    }
  });

program
  .command('evaluate <mints...>')
  .description('run the filter pipeline on specific mints and show every decision with its data source')
  .option('--first-reject', 'stop at the first rejecting filter (default: run all)')
  .action(async (mints: string[], opts: { firstReject?: boolean }) => {
    const { config, logger, storage, clients } = boot();
    try {
      const pairs = await clients.dexscreener.pairsForTokens(mints);
      const candidates: Candidate[] = [];
      for (const m of mints) {
        const c = buildCandidate(m, pairs.filter((p) => p.baseToken.address === m), config, ['manual']);
        if (typeof c === 'string') console.log(`${m}: not evaluated (${c})`);
        else candidates.push(c);
      }
      const size = mulFrac(storage.ledger.balance(), config.strategy.positionSizeFraction);
      const { evaluations } = await evaluateCandidates(
        candidates,
        `manual-${randomUUID()}`,
        size,
        { config, clients, storage, clock: systemClock, logger, filters: ALL_FILTERS },
        { stopOnFirstReject: !!opts.firstReject },
      );
      for (const e of evaluations) {
        console.log(`\n${e.candidate.symbol ?? '?'} ${e.candidate.mint}  mcap $${Math.round(e.candidate.marketCapUsd).toLocaleString('en-US')}  → ${e.result.verdict}`);
        for (const r of e.result.results) {
          const d = (r.data ?? {}) as Record<string, unknown>;
          const src = typeof d.source === 'string' ? d.source : '';
          console.log(`  ${r.filter.padEnd(20)} ${r.outcome.padEnd(18)} ${src.padEnd(9)} ${r.reason ?? ''}${typeof d.onchain === 'string' ? `  [on-chain: ${d.onchain}]` : ''}`);
        }
      }
    } finally {
      storage.close();
    }
  });

program
  .command('collect')
  .description('discovery + filtering loop that never trades: pool listener, periodic scans, evaluations (for gathering stats)')
  .option('--minutes <n>', 'stop after N minutes', (v) => Number(v))
  .action(async (opts: { minutes?: number }) => {
    const { config, secrets, logger, storage, clients } = boot();
    const scanner = new Scanner({ config, clients, storage, clock: systemClock, logger });
    let listener: PoolListener | null = null;
    if (config.scanner.poolListener.enabled) {
      if (!secrets.rpcUrl) logger.warn('SOLANA_RPC_URL not set; pool listener uses the public RPC WebSocket');
      listener = new PoolListener({
        config,
        wsUrl: toWsUrl(secrets.rpcUrl?.reveal() ?? config.apis.rpc.baseUrl),
        rpc: clients.rpc,
        storage,
        clock: systemClock,
        logger,
      });
      listener.start();
    }

    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const started = systemClock.now();
    const endAt = opts.minutes ? started + opts.minutes * 60_000 : Number.POSITIVE_INFINITY;
    let lastReport = started;
    console.log(`Collecting (no trading). Ctrl-C to stop.${opts.minutes ? ` Stops after ${opts.minutes} min.` : ''}`);

    while (!stopping && systemClock.now() < endAt) {
      try {
        const stats = await scanner.scan();
        const size = mulFrac(storage.ledger.balance(), config.strategy.positionSizeFraction);
        const { evaluations, budgetExhausted } = await evaluateCandidates(stats.candidates, stats.scanId, size, {
          config,
          clients,
          storage,
          clock: systemClock,
          logger,
          filters: ALL_FILTERS,
        });
        const passed = evaluations.filter((e) => e.result.verdict === 'passed');
        const l = listener?.stats;
        console.log(
          `${new Date().toISOString()} priced ${stats.priced}, in band ${stats.inBand}, evaluated ${evaluations.length}, passed ${passed.length}` +
            (passed.length ? ` [${passed.map((e) => e.candidate.symbol ?? e.candidate.mint.slice(0, 6)).join(', ')}]` : '') +
            (l ? ` | pools: ${l.connected ? 'connected' : 'disconnected'}, ${l.resolved} resolved, ${l.mintsAdded} new mints` : '') +
            (budgetExhausted ? ` | ${budgetExhausted}` : ''),
        );
      } catch (e) {
        logger.error({ err: e }, 'collect_iteration_failed');
      }
      if (systemClock.now() - lastReport >= 15 * 60_000) {
        lastReport = systemClock.now();
        console.log(`\n${sourcesReport(storage, systemClock.now(), (systemClock.now() - started) / 3_600_000)}\n`);
      }
      const until = Math.min(endAt, systemClock.now() + config.loop.scanIntervalSec * 1000);
      while (!stopping && systemClock.now() < until) await new Promise((r) => setTimeout(r, 500));
    }

    await listener?.stop();
    console.log(`\n${sourcesReport(storage, systemClock.now(), (systemClock.now() - started) / 3_600_000)}`);
    storage.close();
  });

program
  .command('sources')
  .description('discovery yield per source: discovered, candidates and passes per hour')
  .option('--hours <n>', 'window in hours', (v) => Number(v), 24)
  .action((opts: { hours: number }) => {
    const { config } = load();
    const storage = Storage.open({ path: config.storage.path, mode: config.mode, clock: systemClock });
    try {
      console.log(sourcesReport(storage, systemClock.now(), opts.hours));
    } finally {
      storage.close();
    }
  });

program
  .command('filters')
  .description('filter outcome counts (real failures vs. insufficient data)')
  .option('--hours <n>', 'only the last N hours', (v) => Number(v))
  .action((opts: { hours?: number }) => {
    const { config } = load();
    const storage = Storage.open({ path: config.storage.path, mode: config.mode, clock: systemClock });
    try {
      const since = opts.hours ? systemClock.now() - opts.hours * 3_600_000 : 0;
      const ev = storage.audit.evaluationCounts(since);
      console.log(`Evaluations: ${ev.passed} passed, ${ev.rejected} rejected\n`);
      console.log(filterOutcomeReport(storage, since));
    } finally {
      storage.close();
    }
  });

program
  .command('api-usage')
  .description("today's API usage vs. budgets, and the latest rate-limit headers each provider returned")
  .action(() => {
    const { config } = load();
    const storage = Storage.open({ path: config.storage.path, mode: config.mode, clock: systemClock });
    try {
      console.log(apiUsageReport(storage, config, systemClock.now()));
    } finally {
      storage.close();
    }
  });

program.parseAsync().catch((e: unknown) => {
  if (e instanceof ConfigError || e instanceof StorageError) {
    console.error(e.message);
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
