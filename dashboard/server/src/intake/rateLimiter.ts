interface Bucket {
  windowStart: number;
  count: number;
}

export class WindowLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private opts: { windowMs: number; maxAttempts: number; backoffBaseMs?: number }) {}

  hit(key: string, now: number): { allowed: boolean; retryAfterMs: number; attempts: number } {
    let b = this.buckets.get(key);
    if (!b || now - b.windowStart >= this.opts.windowMs) {
      b = { windowStart: now, count: 0 };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (b.count <= this.opts.maxAttempts) {
      return { allowed: true, retryAfterMs: 0, attempts: b.count };
    }
    const over = b.count - this.opts.maxAttempts;
    const base = this.opts.backoffBaseMs ?? 0;
    const remainingWindow = this.opts.windowMs - (now - b.windowStart);
    const retryAfterMs = Math.max(remainingWindow, base * over); // progressive backoff
    return { allowed: false, retryAfterMs, attempts: b.count };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

interface ByteBudgetBucket {
  windowStart: number;
  bytes: number;
}

export class ByteBudget {
  private used = new Map<string, ByteBudgetBucket>();

  constructor(private opts: { windowMs: number; maxBytes: number }) {}

  charge(key: string, bytes: number, now: number): { allowed: boolean; retryAfterMs: number } {
    let u = this.used.get(key);
    if (!u || now - u.windowStart >= this.opts.windowMs) {
      u = { windowStart: now, bytes: 0 };
      this.used.set(key, u);
    }
    if (u.bytes + bytes > this.opts.maxBytes) {
      return { allowed: false, retryAfterMs: this.opts.windowMs - (now - u.windowStart) };
    }
    u.bytes += bytes;
    return { allowed: true, retryAfterMs: 0 };
  }
}
