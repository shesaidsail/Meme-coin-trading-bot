import { readFileSync, existsSync } from 'node:fs';
import { parse as parseDotenv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { ConfigSchema, type Config } from './schema.js';
import { Secret } from '../util/secret.js';

export interface Secrets {
  rpcUrl: Secret | null;
  birdeyeApiKey: Secret | null;
  jupiterApiKey: Secret | null;
  rugcheckApiKey: Secret | null;
  /** Only populated in live mode. Paper mode never reads it. */
  walletPrivateKey: Secret | null;
}

export interface LoadedConfig {
  config: Config;
  secrets: Secrets;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface LoadOptions {
  /** Path to the YAML config file. Missing file → all defaults. */
  configPath?: string;
  /** Path to the .env file. Missing file is fine (env vars may be set directly). */
  envPath?: string;
  /** Process environment; injectable for tests. Takes precedence over the .env file. */
  env?: NodeJS.ProcessEnv;
}

function readEnv(envPath: string | undefined, env: NodeJS.ProcessEnv): Record<string, string> {
  const fromFile = envPath && existsSync(envPath) ? parseDotenv(readFileSync(envPath)) : {};
  const merged: Record<string, string> = { ...fromFile };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) merged[k] = v;
  return merged;
}

function secret(v: string | undefined): Secret | null {
  const t = v?.trim();
  return t ? new Secret(t) : null;
}

/** Parses and validates a raw config object (already loaded from YAML). */
export function parseConfig(raw: unknown): Config {
  try {
    return ConfigSchema.parse(raw ?? {});
  } catch (e) {
    if (e instanceof ZodError) {
      const issues = e.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new ConfigError(`Invalid config:\n${issues.join('\n')}`);
    }
    throw e;
  }
}

export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const configPath = opts.configPath ?? 'config/config.yaml';
  let raw: unknown = {};
  if (existsSync(configPath)) {
    try {
      raw = parseYaml(readFileSync(configPath, 'utf8'));
    } catch (e) {
      throw new ConfigError(`Could not parse ${configPath}: ${(e as Error).message}`);
    }
  } else if (opts.configPath) {
    // An explicitly requested file must exist; the default path may be absent.
    throw new ConfigError(`Config file not found: ${configPath}`);
  }

  const config = parseConfig(raw);
  const env = readEnv(opts.envPath ?? '.env', opts.env ?? process.env);

  const secrets: Secrets = {
    rpcUrl: secret(env.SOLANA_RPC_URL),
    birdeyeApiKey: secret(env.BIRDEYE_API_KEY),
    jupiterApiKey: secret(env.JUPITER_API_KEY),
    rugcheckApiKey: secret(env.RUGCHECK_API_KEY),
    walletPrivateKey: config.mode === 'live' ? secret(env.WALLET_PRIVATE_KEY) : null,
  };

  if (config.mode === 'live') {
    if (!secrets.walletPrivateKey) {
      throw new ConfigError('mode is "live" but WALLET_PRIVATE_KEY is not set in .env');
    }
    if (!secrets.rpcUrl) {
      throw new ConfigError('mode is "live" but SOLANA_RPC_URL is not set in .env');
    }
  }

  return { config, secrets };
}
