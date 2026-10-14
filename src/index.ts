#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, ConfigError } from './config/load.js';
import { Storage, StorageError } from './storage/store.js';
import { systemClock } from './util/clock.js';
import { solToLamports, formatSol } from './util/units.js';

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

program.parseAsync().catch((e: unknown) => {
  if (e instanceof ConfigError || e instanceof StorageError) {
    console.error(e.message);
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
