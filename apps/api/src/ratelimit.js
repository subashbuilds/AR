// A small token-bucket limiter.
//
// Each capture costs the CPU of a full reconstruction, so the API must refuse
// runaway clients rather than queue work until the host falls over. The limiter
// is in-process and deliberately simple: one API process, one bucket per client
// key, no shared state.

export class RateLimiter {
  /**
   * @param {object} options
   * @param {number} options.capacity       bucket size (burst)
   * @param {number} options.refillSeconds  time to regain one token
   * @param {() => number} [options.now]    clock, injectable for tests
   */
  constructor({ capacity, refillSeconds, now = () => Date.now() }) {
    if (!(capacity > 0)) throw new TypeError('capacity must be > 0')
    if (!(refillSeconds > 0)) throw new TypeError('refillSeconds must be > 0')
    this.capacity = capacity
    this.refillMs = refillSeconds * 1000
    this.now = now
    this.buckets = new Map();
  }

  take(key, cost = 1) {
    const nowMs = this.now()
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, updated: nowMs };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, nowMs - bucket.updated);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsed / this.refillMs) * cost);
    bucket.updated = nowMs;

    if (bucket.tokens < 1) {
      const deficit = 1 - bucket.tokens;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((deficit / cost) * this.refillMs / 1000)),
      };
    }
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drops buckets untouched for a full refill so the map cannot grow forever. */
  sweep() {
    const cutoff = this.now() - this.refillMs * this.capacity;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updated < cutoff) this.buckets.delete(key);
    }
  }

  get size() {
    return this.buckets.size;
  }
}