/**
 * Messaging seams (Stage 2.17): the D2.17-9 in-process fixed-window rate
 * limiter default and small composition helpers. No external infrastructure —
 * the interface is the seam; a durable limiter can be injected later without
 * touching the domain.
 */
import type { RateLimiter } from "./types";

export interface FixedWindowRateLimiterOptions {
  /** Window length in ms (frozen default: 60_000). */
  readonly windowMs?: number;
  /** Max consumes per window (frozen default: 10 sends). */
  readonly limit?: number;
  /**
   * Generic per-key overrides for compositions that split the budget across
   * multiple key families (Stage 2.19 beacon: ip=30 / session=60 per 60s).
   * Fall back to `limit` for any key family left unset; messaging's own
   * D2.17-9 usage is unchanged.
   */
  readonly keyLimits?: Readonly<Record<string, number>>;
  /** Injectable clock (tests). */
  readonly now?: () => number;
}

interface WindowState {
  readonly windowStart: number;
  count: number;
}

/**
 * In-process fixed-window limiter. Per-instance semantics (documented): in a
 * multi-process deployment each instance enforces its own budget; the durable
 * limiter is a future composition swap behind the same port.
 */
export const createFixedWindowRateLimiter = (options: FixedWindowRateLimiterOptions = {}): RateLimiter => {
  const windowMs = options.windowMs ?? 60_000;
  const limit = options.limit ?? 10;
  const keyLimits = options.keyLimits ?? {};
  const limitForKey = (key: string): number => {
    const family = key.split(":")[0] ?? "";
    return keyLimits[family] ?? limit;
  };
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, WindowState>();

  return {
    async consume(key: string): Promise<boolean> {
      const t = now();
      const current = windows.get(key);
      if (!current || t - current.windowStart >= windowMs) {
        windows.set(key, { windowStart: t, count: 1 });
        return true;
      }
      if (current.count >= limitForKey(key)) return false;
      current.count += 1;
      return true;
    },
  };
};
