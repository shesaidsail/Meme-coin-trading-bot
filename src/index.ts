#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, ConfigError } from './config/load.js';
import { Storage, StorageError } from './storage/store.js';
import { systemClock } from './util/clock.js';
import { solToLamports, formatSol, mulFrac } from './util/units.js';
import { createLogger } from './util/logger.js';
import pino from 'pino';
import { createClients } from './clients/index.js';
import { Scanner } from './scanner/scanner.js';
import { evaluateCandidates } from './engine/evaluate.js';
import { ALL_FILTERS } from './filters/index.js';
import { apiUsageReport, evaluationsReport, filterOutcomeReport, rugcheckScoreDistribution } from './cli/reports.js';

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
