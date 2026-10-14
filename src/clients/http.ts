import type { z } from 'zod';
import type { Clock } from '../util/clock.js';
import type { Logger } from '../util/logger.js';
import type { UsageRepo, RateObservationsRepo } from '../storage/usage.repo.js';
import { redactString } from '../util/redact.js';
import { RateLimiter, realSleep, type Sleep } from './rate-limiter.js';
import { Budget, type Priority } from './budget.js';
import { ApiError } from './errors.js';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface ProviderSettings {
  name: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  rateLimit: { maxPerSecond: number; maxPerMinute: number };
  budget: { unitsPerDay: number; reserveFraction: number };
  /** Headers sent with every request (e.g. API keys). Never logged. */
  defaultHeaders?: Record<string, string>;
}

export interface HttpDeps {
  clock: Clock;
  logger: Logger;
  usage: UsageRepo;
  rateObservations: RateObservationsRepo;
  /** Minimum interval between stored header samples per provider. */
  rateHeaderSampleMs: number;
  fetch?: FetchFn;
  sleep?: Sleep;
}

export interface RequestOptions<T> {
  /** Path appended to baseUrl, or an absolute URL. */
  path: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  schema: z.ZodType<T>;
  /** Budget units this call costs (default 1). */
  units?: number;
  priority?: Priority;
  /**
   * Some APIs (JSON-RPC) report throttling inside a 200 body. Return true to
   * treat the body as a 429.
   */
  isThrottledBody?: (body: unknown) => boolean;
  /** Label for metrics/observations (default: URL path with addresses collapsed). */
  endpoint?: string;
  /** Overrides the provider's maxRetries (e.g. 0 when the caller has a fallback). */
  maxRetries?: number;
}

const RATE_HEADER = /rate|limit|retry|quota|credit/i;
const BASE58_ID = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/** Endpoint label for metrics: path only, with addresses collapsed. */
function endpointLabel(url: URL): string {
  return url.pathname.replace(BASE58_ID, ':id').replace(/(:id,?)+/g, ':id');
}

function rateHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (RATE_HEADER.test(k) && k !== 'set-cookie') out[k] = v;
  });
  return out;
}

/** retry-after may be seconds or an HTTP date. */
function retryAfterMs(h: Headers, now: number): number | null {
  const v = h.get('retry-after');
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/**
 * One instance per provider. Every call is budget-checked, rate-limited,
 * timed out, retried with backoff on 429/5xx/network errors, counted in
 * SQLite, and validated against a zod schema.
 */
export class HttpClient {
  readonly limiter: RateLimiter;
  readonly budget: Budget;
  private readonly fetchFn: FetchFn;
  private readonly sleep: Sleep;
  private lastHeaderSample = 0;

  constructor(
    readonly settings: ProviderSettings,
    private readonly deps: HttpDeps,
  ) {
    this.sleep = deps.sleep ?? realSleep;
    this.fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
    this.limiter = new RateLimiter(settings.rateLimit, deps.clock, this.sleep);
    this.budget = new Budget(settings.name, settings.budget, deps.usage, deps.clock);
  }

  get name(): string {
    return this.settings.name;
  }

  async request<T>(opts: RequestOptions<T>): Promise<T> {
    const url = this.buildUrl(opts);
    const units = opts.units ?? 1;
    const priority = opts.priority ?? 'normal';
    const label = opts.endpoint ?? endpointLabel(url);
    const { name } = this.settings;
    const maxRetries = opts.maxRetries ?? this.settings.maxRetries;

    for (let attempt = 0; ; attempt++) {
      this.budget.check(units, priority);
      await this.limiter.acquire();
      this.budget.charge(units);

      let res: Response;
      try {
        res = await this.fetchWithTimeout(url, opts);
      } catch (e) {
        const timeout = (e as Error).name === 'AbortError' || (e as Error).name === 'TimeoutError';
        this.deps.usage.add(name, this.deps.clock.now(), { errors: 1 });
        const err = new ApiError(
          name,
          timeout ? 'timeout' : 'network',
          timeout ? `timeout after ${this.settings.timeoutMs}ms on ${label}` : redactString(String((e as Error).message)),
        );
        if (attempt < maxRetries) {
          await this.backoff(attempt, null, label, err.message);
          continue;
        }
        throw err;
      }

      const headers = rateHeaders(res.headers);
      const body = await this.readBody(res);
      const throttled = res.status === 429 || (res.ok && opts.isThrottledBody?.(body) === true);
      this.observe(label, throttled ? 429 : res.status, headers, throttled);

      if (throttled) {
        this.deps.usage.add(name, this.deps.clock.now(), { throttled: 1 });
        const ra = retryAfterMs(res.headers, this.deps.clock.now());
        if (ra !== null) this.limiter.pauseUntil(this.deps.clock.now() + ra);
        if (attempt < maxRetries) {
          await this.backoff(attempt, ra, label, 'rate limited (429)');
          continue;
        }
        throw new ApiError(name, 'rate_limited', `rate limited on ${label}`, 429, body);
      }

      if (res.status >= 500) {
        this.deps.usage.add(name, this.deps.clock.now(), { errors: 1 });
        if (attempt < maxRetries) {
          await this.backoff(attempt, retryAfterMs(res.headers, this.deps.clock.now()), label, `HTTP ${res.status}`);
          continue;
        }
        throw new ApiError(name, 'http', `HTTP ${res.status} on ${label}`, res.status, body);
      }

      if (!res.ok) {
        // 4xx other than 429 is a definitive answer (bad request, not found, not tradable): no retry.
        this.deps.usage.add(name, this.deps.clock.now(), { errors: 1 });
        throw new ApiError(name, 'http', `HTTP ${res.status} on ${label}`, res.status, body);
      }

      const parsed = opts.schema.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ApiError(
          name,
          'schema',
          `unexpected response shape on ${label}: ${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`.trim(),
          res.status,
        );
      }
      return parsed.data;
    }
  }

  private buildUrl(opts: RequestOptions<unknown>): URL {
    let url: URL;
    if (opts.path === '') {
      // The base URL exactly (JSON-RPC endpoints often carry ?api-key=).
      url = new URL(this.settings.baseUrl);
    } else if (/^https?:\/\//.test(opts.path)) {
      url = new URL(opts.path);
    } else {
      // Join paths but keep the base URL's own query (e.g. ?api-key=).
      url = new URL(this.settings.baseUrl);
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/${opts.path.replace(/^\/+/, '')}`;
    }
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url;
  }

  private async fetchWithTimeout(url: URL, opts: RequestOptions<unknown>): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.settings.defaultHeaders,
      ...opts.headers,
    };
    const init: RequestInit = { method: opts.method ?? 'GET', headers, signal: AbortSignal.timeout(this.settings.timeoutMs) };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return this.fetchFn(url.toString(), init);
  }

  private async readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text.slice(0, 500) };
    }
  }

  private observe(endpoint: string, status: number, headers: Record<string, string>, force: boolean): void {
    const now = this.deps.clock.now();
    const hasHeaders = Object.keys(headers).length > 0;
    if (!force && (!hasHeaders || now - this.lastHeaderSample < this.deps.rateHeaderSampleMs)) return;
    this.lastHeaderSample = now;
    this.deps.rateObservations.insert({ ts: now, provider: this.name, endpoint, status, headers });
    this.deps.logger.info({ provider: this.name, endpoint, status, rateHeaders: headers }, 'rate_limit_headers');
  }

  private async backoff(attempt: number, retryAfter: number | null, label: string, why: string): Promise<void> {
    const exp = Math.min(30_000, 500 * 2 ** attempt);
    const jitter = Math.floor(Math.random() * 250);
    const wait = Math.max(retryAfter ?? 0, exp + jitter);
    this.deps.logger.warn({ provider: this.name, endpoint: label, attempt: attempt + 1, waitMs: wait, why }, 'api_retry');
    await this.sleep(wait);
  }
}
