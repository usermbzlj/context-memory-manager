/**
 * Shared score utilities for the retention scorers.
 */

/**
 * Clamp a score to [0,1]. Non-finite input (NaN, ±Infinity) yields 0.5 —
 * a score the caller has no evidence for must not silently bias toward
 * either eviction or retention.
 */
export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
