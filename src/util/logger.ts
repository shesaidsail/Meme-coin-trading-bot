import pino, { type Logger, type DestinationStream } from 'pino';
import { SENSITIVE_KEYS, redactString } from './redact.js';

export type { Logger };

/**
 * Structured JSON logger. Sensitive keys are redacted at any depth up to two
 * levels, and every string value is scrubbed of embedded credentials
 * (e.g. an RPC URL with `?api-key=` inside an error message).
 */
export function createLogger(
  opts: { level?: string; name?: string } = {},
  destination?: DestinationStream,
): Logger {
  const paths = SENSITIVE_KEYS.flatMap((k) => {
    const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `["${k}"]`;
    const sep = key.startsWith('[') ? '' : '.';
    return [key, `*${sep}${key}`, `*.*${sep}${key}`];
  });

  return pino(
    {
      name: opts.name ?? 'bot',
      level: opts.level ?? 'info',
      redact: { paths, censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        log: (obj) => scrub(obj) as Record<string, unknown>,
      },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === 'string' ? redactString(a) : a));
          method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
      serializers: {
        err: (e: Error) => ({
          type: e.name,
          message: redactString(e.message),
          stack: e.stack ? redactString(e.stack) : undefined,
        }),
      },
    },
    destination,
  );
}

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 6) return v;
  if (typeof v === 'string') return redactString(v);
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x, depth + 1);
    return out;
  }
  return v;
}
