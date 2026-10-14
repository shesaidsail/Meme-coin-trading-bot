import type { FetchFn } from '../../src/clients/http.js';

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = FakeResponse | ((url: URL, init: RequestInit) => FakeResponse | Promise<FakeResponse>);

/**
 * Route-based fake for fetch. Routes are matched in order against
 * "METHOD url"; a route given an array of responses serves them in turn
 * (the last one repeats). Unmatched requests fail the test loudly.
 */
export class FakeFetch {
  readonly calls: { method: string; url: string; body: unknown }[] = [];
  private routes: { re: RegExp; handlers: Handler[]; i: number }[] = [];

  on(re: RegExp, ...handlers: Handler[]): this {
    this.routes.push({ re, handlers, i: 0 });
    return this;
  }

  count(re: RegExp): number {
    return this.calls.filter((c) => re.test(`${c.method} ${c.url}${c.body ? ` ${JSON.stringify(c.body)}` : ''}`)).length;
  }

  readonly fetch: FetchFn = async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, url, body });
    const key = `${method} ${url}${body ? ` ${JSON.stringify(body)}` : ''}`;
    const route = this.routes.find((r) => r.re.test(key));
    if (!route) throw new Error(`FakeFetch: no route for ${key}`);
    const h = route.handlers[Math.min(route.i++, route.handlers.length - 1)]!;
    const r = typeof h === 'function' ? await h(new URL(url), init) : h;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  };
}

/** A JSON-RPC success envelope. */
export const rpcOk = (result: unknown): FakeResponse => ({ body: { jsonrpc: '2.0', id: 1, result } });
