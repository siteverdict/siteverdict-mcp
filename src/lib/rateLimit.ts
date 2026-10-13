import { RateLimitError } from './errors.js';

/**
 * Per-client limits (in-memory, per process):
 *  - sliding window of N tool calls per 60 s
 *  - max concurrent Actor runs
 * The client key is "stdio" for local installs, or a hash of the caller's token / API key / IP for HTTP.
 */
export class ClientLimiter {
  private readonly calls = new Map<string, number[]>();
  private readonly running = new Map<string, number>();

  constructor(
    private readonly perMinute: number,
    private readonly maxConcurrent: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one call or throws RateLimitError. */
  hit(key: string): void {
    const t = this.now();
    const windowStart = t - 60_000;
    const list = (this.calls.get(key) ?? []).filter((x) => x > windowStart);
    if (list.length >= this.perMinute) {
      const retry = Math.max(1, Math.ceil((list[0]! + 60_000 - t) / 1000));
      this.calls.set(key, list);
      throw new RateLimitError(`Rate limit: max ${this.perMinute} audit calls per minute. Retry in ${retry}s.`, retry);
    }
    list.push(t);
    this.calls.set(key, list);
    if (this.calls.size > 10_000) this.gc(windowStart);
  }

  /** Reserves `n` concurrent run slots; returns a release function. */
  acquire(key: string, n = 1): () => void {
    const cur = this.running.get(key) ?? 0;
    if (cur + n > this.maxConcurrent) {
      throw new RateLimitError(
        `Too many audits running at once (max ${this.maxConcurrent} Actor runs per client). Wait for one to finish.`,
        15,
      );
    }
    this.running.set(key, cur + n);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.running.get(key) ?? n) - n;
      if (left <= 0) this.running.delete(key);
      else this.running.set(key, left);
    };
  }

  private gc(windowStart: number): void {
    for (const [k, v] of this.calls) if (!v.some((x) => x > windowStart)) this.calls.delete(k);
  }
}
