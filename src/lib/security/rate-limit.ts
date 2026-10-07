export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the oldest hit leaves the window. */
  retryAfterSeconds: number;
}

/**
 * Sliding-window limiter held in memory. It is per server instance: on a serverless host each
 * instance counts separately, so treat it as a cost guard, not a hard security boundary.
 */
export function createRateLimiter(opts: { limit: number; windowMs: number; now?: () => number }) {
  const hits = new Map<string, number[]>();
  const now = opts.now ?? (() => Date.now());

  return {
    check(key: string): RateLimitResult {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((h) => t - h < opts.windowMs);
      if (recent.length >= opts.limit) {
        hits.set(key, recent);
        const oldest = recent[0] ?? t;
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((oldest + opts.windowMs - t) / 1000)) };
      }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (v.every((h) => t - h >= opts.windowMs)) hits.delete(k);
      }
      return { allowed: true, remaining: opts.limit - recent.length, retryAfterSeconds: 0 };
    },
  };
}
