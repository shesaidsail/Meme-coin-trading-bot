import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { redactString } from '../../src/util/redact.js';
import { createLogger } from '../../src/util/logger.js';
import { Secret } from '../../src/util/secret.js';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { base58Encode, base58Decode } from '../../src/util/base58.js';

/** A real Solana-format secret key: 32-byte seed || 32-byte public key, base58. */
function solanaSecretKey(): string {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return base58Encode(Uint8Array.from([...seed, ...pub]));
}

const FAKE_KEY = solanaSecretKey();
/** A transaction signature: also 64 bytes, must NOT be redacted. */
const SIGNATURE = base58Encode(Uint8Array.from(randomBytes(64)));

describe('redaction', () => {
  it('scrubs api keys in URLs, bearer tokens and base58 secret keys', () => {
    expect(redactString('https://mainnet.helius-rpc.com/?api-key=abc123')).toBe(
      'https://mainnet.helius-rpc.com/?api-key=[REDACTED]',
    );
    expect(redactString('Authorization: Bearer xyz.abc')).toBe('Authorization: Bearer [REDACTED]');
    expect(FAKE_KEY.length).toBeGreaterThanOrEqual(85);
    expect(redactString(`key=${FAKE_KEY} end`)).toBe('key=[REDACTED] end');
  });

  it('keeps transaction signatures (same length as secret keys) intact', () => {
    expect(SIGNATURE.length).toBeGreaterThanOrEqual(85);
    expect(redactString(`sig ${SIGNATURE}`)).toBe(`sig ${SIGNATURE}`);
    const real = '53HNQMxW858okz56oqK5vq5yEPxTAbNXVcvnzkDnEG5moWMBArntv6LsXTSjP1QH5kQfqYUfD7fetb5ny43y1oER';
    expect(redactString(real)).toBe(real);
  });

  it('base58 round-trips, including leading zero bytes', () => {
    const b = Uint8Array.from([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(b))).toEqual(b);
    expect(base58Decode('0OIl')).toBeNull();
  });

  it('leaves mint addresses (32-44 chars) intact', () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    expect(redactString(`mint ${mint}`)).toBe(`mint ${mint}`);
  });
});

describe('logger', () => {
  function capture() {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    return { lines, logger: createLogger({ level: 'info' }, stream) };
  }

  it('never writes secrets', () => {
    const { lines, logger } = capture();
    logger.info({ privateKey: 'P1', nested: { apiKey: 'P2' }, s: new Secret('P3') }, 'hello');
    logger.info({ url: 'https://rpc/?api-key=P4' }, 'calling https://rpc/?api-key=P5');
    logger.error({ err: new Error('failed https://rpc/?api-key=P6') }, 'boom');
    logger.info(`raw key ${FAKE_KEY}`);
    const out = lines.join('\n');
    for (const s of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', FAKE_KEY]) {
      expect(out).not.toContain(`=${s}`);
      expect(out).not.toContain(`"${s}"`);
    }
    expect(out).not.toContain(FAKE_KEY);
    expect(out).toContain('hello');
  });

  it('serialises bigints', () => {
    const { lines, logger } = capture();
    logger.info({ amount: 123n }, 'x');
    expect(JSON.parse(lines[0]!).amount).toBe('123');
  });
});
