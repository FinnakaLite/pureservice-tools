// The ONLY place that talks HTTP to PureService. Everything goes through one
// token bucket so the whole process stays under `requestsPerMinute`, honours
// 429 Retry-After, retries reads on transient errors, and stops calling
// entirely (circuit breaker) when PureService is unhealthy.

import type { Logger } from '../core/log.ts';

export class ApiError extends Error {
  readonly status: number;
  /** true when we can't know whether a write reached PureService (timeout, network, 5xx). */
  readonly ambiguous: boolean;
  readonly body: unknown;
  constructor(message: string, status: number, ambiguous: boolean, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.ambiguous = ambiguous;
    this.body = body;
  }
}

export class CircuitOpenError extends Error {
  constructor(until: Date) {
    super(`PureService circuit open until ${until.toISOString()}`);
    this.name = 'CircuitOpenError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Token bucket: `perMinute` tokens, refilled continuously. Can be paused (429). */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private pausedUntil = 0;
  private readonly perMinute: number;
  private queue: Promise<void> = Promise.resolve();
  constructor(perMinute: number) {
    this.perMinute = perMinute;
    // Start with a small burst allowance, not a full minute's worth.
    this.tokens = Math.min(5, perMinute);
  }
  pause(ms: number) { this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms); }
  /** Resolves when a request may be sent. Calls are served in order. */
  acquire(): Promise<void> {
    const next = this.queue.then(async () => {
      for (;;) {
        const now = Date.now();
        if (now < this.pausedUntil) { await sleep(this.pausedUntil - now); continue; }
        this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) / 60000) * this.perMinute);
        this.last = now;
        if (this.tokens >= 1) { this.tokens -= 1; return; }
        await sleep(Math.ceil(((1 - this.tokens) / this.perMinute) * 60000));
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  requestsPerMinute: number;
  log: Logger;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class PureServiceClient {
  readonly limiter: RateLimiter;
  private readonly opts: ClientOptions;
  private readonly fetchImpl: typeof fetch;
  private consecutiveFailures = 0;
  private openUntil = 0;
  requestCount = 0;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.limiter = new RateLimiter(opts.requestsPerMinute);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get circuitOpen(): boolean { return Date.now() < this.openUntil; }

  get<T = any>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    return this.request<T>('GET', path, query, undefined, 2);
  }

  /** Writes are never retried automatically: a failed POST may still have landed. */
  post<T = any>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, {}, body, 0);
  }

  private async request<T>(method: string, path: string, query: Record<string, string | number | undefined>, body: unknown, retries: number): Promise<T> {
    const url = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const where = `${method} ${url.pathname}`;

    for (let attempt = 0; ; attempt++) {
      if (this.circuitOpen) throw new CircuitOpenError(new Date(this.openUntil));
      await this.limiter.acquire();
      this.requestCount++;

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            'X-Authorization-Key': this.opts.apiKey,
            Accept: 'application/vnd.api+json',
            ...(body !== undefined ? { 'Content-Type': 'application/vnd.api+json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15000),
        });
      } catch (e) {
        this.recordFailure();
        if (attempt < retries) { await sleep(1000 * 4 ** attempt); continue; }
        throw new ApiError(`${where} failed: ${(e as Error).message}`, 0, true);
      }

      if (res.status === 429) {
        const wait = Math.max(1, Number(res.headers.get('retry-after')) || 15) * 1000;
        this.opts.log.warn('rate limited by PureService', { where, waitMs: wait });
        this.limiter.pause(wait);
        if (attempt < 3) continue; // 429 means "not processed" — safe to retry even for POST
        throw new ApiError(`${where}: 429 Too Many Requests`, 429, false);
      }

      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

      if (res.status >= 500) {
        this.recordFailure();
        if (attempt < retries) { await sleep(1000 * 4 ** attempt); continue; }
        throw new ApiError(`${where}: HTTP ${res.status}`, res.status, true, json ?? text.slice(0, 300));
      }
      if (res.status >= 400) {
        // A client error is our fault, not PureService being down: don't trip the breaker.
        throw new ApiError(`${where}: HTTP ${res.status} ${JSON.stringify((json as any)?.errors ?? text.slice(0, 200))}`, res.status, false, json);
      }
      this.consecutiveFailures = 0;
      return json as T;
    }
  }

  private recordFailure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 5) {
      this.openUntil = Date.now() + 5 * 60_000;
      this.consecutiveFailures = 0;
      this.opts.log.error('PureService unhealthy — pausing all calls for 5 minutes');
    }
  }
}
