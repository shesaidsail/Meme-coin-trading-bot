/**
 * Removes credentials from strings that may end up in logs or the audit log:
 * query-string API keys (Helius embeds `?api-key=` in the RPC URL), bearer
 * tokens, and anything that looks like a base58 Solana secret key (64 bytes ≈ 87-88 chars).
 */
const QUERY_KEY = /([?&](?:api[-_]?key|apikey|key|token|secret|access_token)=)[^&#\s"']+/gi;
const BEARER = /(bearer\s+)[a-z0-9._~+/-]+=*/gi;
const BASE58_SECRET = /\b[1-9A-HJ-NP-Za-km-z]{85,90}\b/g;

export function redactString(s: string): string {
  return s
    .replace(QUERY_KEY, '$1[REDACTED]')
    .replace(BEARER, '$1[REDACTED]')
    .replace(BASE58_SECRET, '[REDACTED]');
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
