import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { redactString } from '../../src/util/redact.js';
import { createLogger } from '../../src/util/logger.js';
import { Secret } from '../../src/util/secret.js';

const FAKE_KEY = '4'.repeat(10) + 'AbCdEfGhJkLmNpQrStUvWxYz'.repeat(3) + '5'.repeat(5); // 87 base58 chars

describe('redaction', () => {
  it('scrubs api keys in URLs, bearer tokens and base58 secret keys', () => {
    expect(redactString('https://mainnet.helius-rpc.com/?api-key=abc123')).toBe(
      'https://mainnet.helius-rpc.com/?api-key=[REDACTED]',
    );
    expect(redactString('Authorization: Bearer xyz.abc')).toBe('Authorization: Bearer [REDACTED]');
    expect(FAKE_KEY).toHaveLength(87);
    expect(redactString(`key=${FAKE_KEY} end`)).not.toContain(FAKE_KEY);
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
