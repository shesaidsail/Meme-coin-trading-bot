import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadConfig, parseConfig, ConfigError } from '../../src/config/load.js';

const missingEnv = join(tmpdir(), 'definitely-missing.env');

function tmpYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const p = join(dir, 'config.yaml');
  writeFileSync(p, content);
  return p;
}

describe('config schema', () => {
  it('applies every default from an empty object, including nested ones', () => {
    const c = parseConfig({});
    expect(c.mode).toBe('paper');
    expect(c.paper.startingSol).toBe(10);
    expect(c.strategy.positionSizeFraction).toBe(0.05);
    expect(c.strategy.maxOpenPositions).toBe(10);
    expect(c.strategy.maxDeployedFraction).toBe(0.5);
    expect(c.strategy.targetNetMultiplier).toBe(2.5);
    expect(c.strategy.timeStopHours).toBe(48);
    expect(c.strategy.stopLoss.enabled).toBe(false);
    expect(c.strategy.unquotableAfterFailures).toBe(3);
    expect(c.universe).toEqual({ minMarketCapUsd: 150_000, maxMarketCapUsd: 600_000, targetMarketCapUsd: 300_000 });
    expect(c.filters.liquidity.minLiquidityUsd).toBe(40_000);
    expect(c.filters.liquidity.minLiquidityToMcap).toBe(0.1);
    expect(c.filters.holderConcentration.maxTop10Fraction).toBe(0.3);
    expect(c.filters.holderConcentration.maxSingleWalletFraction).toBe(0.05);
    expect(c.filters.tokenAge.minAgeMinutes).toBe(30);
    expect(c.apis.jupiter.budget.reserveFraction).toBe(0.25);
  });

  it('defaults every filter to enabled with onMissingData=reject', () => {
    const c = parseConfig({});
    for (const [name, f] of Object.entries(c.filters)) {
      expect(f.enabled, name).toBe(true);
      expect(f.onMissingData, name).toBe('reject');
    }
  });

  it('config/config.yaml documents exactly the built-in defaults', () => {
    const fromFile = parseConfig(parseYaml(readFileSync('config/config.yaml', 'utf8')));
    expect(fromFile).toEqual(parseConfig({}));
  });

  it('allows per-filter missing-data policy overrides', () => {
    const c = parseConfig({
      filters: { bundledLaunch: { onMissingData: 'warn' }, devWallet: { onMissingData: 'skip' } },
    });
    expect(c.filters.bundledLaunch.onMissingData).toBe('warn');
    expect(c.filters.devWallet.onMissingData).toBe('skip');
    expect(c.filters.bundledLaunch.maxLaunchBuyFraction).toBe(0.2); // sibling defaults kept
    expect(c.filters.honeypot.onMissingData).toBe('reject');
  });

  it.each([
    [{ filters: { liquidity: { onMissingData: 'ignore' } } }, 'filters.liquidity.onMissingData'],
    [{ strategy: { maxDeployedFraction: 1.5 } }, 'strategy.maxDeployedFraction'],
    [{ strategy: { targetNetMultiplier: 1 } }, 'strategy.targetNetMultiplier'],
    [{ universe: { minMarketCapUsd: 700_000 } }, 'universe.minMarketCapUsd'],
    [{ universe: { targetMarketCapUsd: 50_000 } }, 'universe.targetMarketCapUsd'],
    [{ strategy: { positionSizeFraction: 0.6 } }, 'strategy.positionSizeFraction'],
    [{ execution: { sell: { initialSlippageBps: 3000 } } }, 'execution.sell.initialSlippageBps'],
    [{ mode: 'yolo' }, 'mode'],
  ])('rejects invalid config %j', (raw, path) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(path);
  });
});

describe('loadConfig', () => {
  it('uses defaults when the default config path is absent', () => {
    const { config } = loadConfig({ configPath: undefined, envPath: missingEnv, env: {} });
    expect(config.mode).toBe('paper');
  });

  it('fails if an explicitly given config file does not exist', () => {
    expect(() => loadConfig({ configPath: '/nope/config.yaml', envPath: missingEnv, env: {} })).toThrow(
      ConfigError,
    );
  });

  it('never reads the wallet key in paper mode', () => {
    const { secrets } = loadConfig({
      configPath: tmpYaml('mode: paper\n'),
      envPath: missingEnv,
      env: { WALLET_PRIVATE_KEY: 'abc', SOLANA_RPC_URL: 'https://rpc.example/?api-key=xyz' },
    });
    expect(secrets.walletPrivateKey).toBeNull();
    expect(secrets.rpcUrl?.reveal()).toBe('https://rpc.example/?api-key=xyz');
  });

  it('live mode requires an explicit flag AND a wallet key AND an RPC URL', () => {
    const live = tmpYaml('mode: live\n');
    expect(() => loadConfig({ configPath: live, envPath: missingEnv, env: {} })).toThrow(/WALLET_PRIVATE_KEY/);
    expect(() =>
      loadConfig({ configPath: live, envPath: missingEnv, env: { WALLET_PRIVATE_KEY: 'k' } }),
    ).toThrow(/SOLANA_RPC_URL/);
    const { config, secrets } = loadConfig({
      configPath: live,
      envPath: missingEnv,
      env: { WALLET_PRIVATE_KEY: 'k', SOLANA_RPC_URL: 'https://rpc.example' },
    });
    expect(config.mode).toBe('live');
    expect(secrets.walletPrivateKey?.reveal()).toBe('k');
  });

  it('reads secrets from a .env file, with process env taking precedence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'BIRDEYE_API_KEY=fromfile\nRUGCHECK_API_KEY=rc\n');
    const { secrets } = loadConfig({ envPath, env: { BIRDEYE_API_KEY: 'fromenv' } });
    expect(secrets.birdeyeApiKey?.reveal()).toBe('fromenv');
    expect(secrets.rugcheckApiKey?.reveal()).toBe('rc');
    expect(secrets.jupiterApiKey).toBeNull();
  });

  it('secrets never serialise', () => {
    const { secrets } = loadConfig({
      configPath: tmpYaml('mode: live\n'),
      envPath: missingEnv,
      env: { WALLET_PRIVATE_KEY: 'SUPERSECRET', SOLANA_RPC_URL: 'https://x/?api-key=SUPERSECRET' },
    });
    expect(JSON.stringify(secrets)).not.toContain('SUPERSECRET');
    expect(inspect(secrets, { depth: 5 })).not.toContain('SUPERSECRET');
    expect(`${secrets.walletPrivateKey}`).not.toContain('SUPERSECRET');
  });
});
