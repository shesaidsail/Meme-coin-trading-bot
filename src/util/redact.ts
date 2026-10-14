import { createPrivateKey, createPublicKey } from 'node:crypto';
import { base58Decode } from './base58.js';

/**
 * Removes credentials from strings that may end up in logs or the audit log:
 * query-string API keys (Helius embeds `?api-key=` in the RPC URL), bearer
 * tokens, and base58 Solana secret keys.
 *
 * A secret key and a transaction signature are both 64 bytes, so length
 * cannot tell them apart (and signatures must stay visible). A Solana secret
 * key is a 32-byte ed25519 seed followed by its own public key, so a
 * candidate is redacted only if its second half is the public key derived
 * from its first half.
 */
const QUERY_KEY = /([?&](?:api[-_]?key|apikey|key|token|secret|access_token)=)[^&#\s"']+/gi;
const BEARER = /(bearer\s+)[a-z0-9._~+/-]+=*/gi;
const BASE58_SECRET = /\b[1-9A-HJ-NP-Za-km-z]{85,90}\b/g;

/** PKCS#8 DER prefix for an ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function isSolanaSecretKey(b58: string): boolean {
  const bytes = base58Decode(b58);
  if (!bytes || bytes.length !== 64) return false;
  try {
    const priv = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, bytes.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
    const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' });
    return Buffer.from(pub.subarray(pub.length - 32)).equals(Buffer.from(bytes.subarray(32)));
  } catch {
    return false;
  }
}

export function redactString(s: string): string {
  return s
    .replace(QUERY_KEY, '$1[REDACTED]')
    .replace(BEARER, '$1[REDACTED]')
    .replace(BASE58_SECRET, (m) => (isSolanaSecretKey(m) ? '[REDACTED]' : m));
}

/** Keys whose values are always redacted when logging objects. */
export const SENSITIVE_KEYS = [
  'privateKey',
  'secretKey',
  'WALLET_PRIVATE_KEY',
  'apiKey',
  'api_key',
  'authorization',
  'Authorization',
  'x-api-key',
  'X-API-KEY',
  'rpcUrl',
  'SOLANA_RPC_URL',
  'BIRDEYE_API_KEY',
  'JUPITER_API_KEY',
  'RUGCHECK_API_KEY',
  'secrets',
];
