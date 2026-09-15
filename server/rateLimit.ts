import type { RequestHandler } from 'express';

type Bucket = { count: number; resetsAt: number };
type RateLimitOptions = {
  accountLimit?: number;
  ipLimit?: number;
  globalLimit?: number;
  windowMs: number;
  message: string;
};

const MAX_BUCKETS_PER_SCOPE = 10_000;

/**
 * Small in-memory limiter for this single-instance demo. Account, IP and global
 * limits use separate buckets, so changing networks cannot reset an account's
 * allowance and creating accounts cannot reset an IP's allowance.
 *
 * Production systems with several server instances should replace this with a
 * shared store.
 */
export function createMemoryRateLimit({ accountLimit, ipLimit, globalLimit, windowMs, message }: RateLimitOptions): RequestHandler {
  const limits = [accountLimit, ipLimit, globalLimit].filter((value): value is number => value !== undefined);
  if (!Number.isFinite(windowMs) || windowMs <= 0 || !limits.length || limits.some(value => !Number.isInteger(value) || value <= 0)) {
    throw new Error('Rate limits and their window must be positive numbers.');
  }

  const accountBuckets = new Map<string, Bucket>();
  const ipBuckets = new Map<string, Bucket>();
  const globalBuckets = new Map<string, Bucket>();

  const consume = (buckets: Map<string, Bucket>, key: string, limit: number, now: number) => {
    for (const [bucketKey, bucket] of buckets) if (bucket.resetsAt <= now) buckets.delete(bucketKey);
    if (!buckets.has(key) && buckets.size >= MAX_BUCKETS_PER_SCOPE) {
      const oldest = buckets.keys().next().value as string | undefined;
      if (oldest) buckets.delete(oldest);
    }
    const current = buckets.get(key);
    const bucket = !current || current.resetsAt <= now ? { count: 0, resetsAt: now + windowMs } : current;
    bucket.count++;
    buckets.set(key, bucket);
    return { limit, remaining: Math.max(0, limit - bucket.count), resetsAt: bucket.resetsAt, blocked: bucket.count > limit };
  };

  return (req, res, next) => {
    const now = Date.now();
    const results: ReturnType<typeof consume>[] = [];
    const accountId = typeof res.locals.user?.id === 'string' ? res.locals.user.id.slice(0, 160) : '';
    const ip = String(req.ip || req.socket.remoteAddress || 'local').slice(0, 160);

    if (accountLimit !== undefined && accountId) results.push(consume(accountBuckets, accountId, accountLimit, now));
    if (ipLimit !== undefined) results.push(consume(ipBuckets, ip, ipLimit, now));
    if (globalLimit !== undefined) results.push(consume(globalBuckets, 'all', globalLimit, now));
    if (!results.length) { next(); return; }

    // Report the policy with the least proportional allowance remaining.
    const closest = results.reduce((selected, result) =>
      result.remaining / result.limit < selected.remaining / selected.limit ? result : selected);
    res.setHeader('RateLimit-Limit', String(closest.limit));
    res.setHeader('RateLimit-Remaining', String(closest.remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(closest.resetsAt / 1000)));

    const blocked = results.filter(result => result.blocked).sort((a, b) => a.resetsAt - b.resetsAt)[0];
    if (blocked) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((blocked.resetsAt - now) / 1000))));
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}
