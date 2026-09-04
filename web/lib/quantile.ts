/**
 * A rolling quantile scale over recent priority fees.
 *
 * Why rank and not value: "expensive" at 03:00 and "expensive" at 15:00 are
 * different numbers of gwei and must read as the same brightness. Ranking a
 * transaction against the fees currently in the window does that, and it
 * rescales itself as the market moves without anyone choosing a constant.
 *
 * Hand-written rather than pulling in d3-scale for one function: a ring buffer,
 * a sort at a few Hz, and a binary search.
 */

export type QuantileScale = {
  /** Records a sample. Called once per arrival, so it must stay O(1). */
  push(value: number): void;
  /**
   * Rebuilds the sorted view. Call at 2–4 Hz from the loop, never per frame:
   * this is the only O(n log n) in the render path.
   */
  rebuild(): void;
  /** Rank of `value` within the window, 0..1. Binary search, O(log n). */
  percentile(value: number): number;
  /** The value standing at `p` in 0..1. */
  valueAt(p: number): number;
  /** Samples currently held. */
  size(): number;
  /** True once there is enough of a window for a rank to mean anything. */
  ready(): boolean;
};

export type QuantileOptions = {
  /** Ring buffer capacity. The window is the last N samples, not N seconds. */
  capacity?: number;
  /** Samples needed before `ready()`. */
  minSamples?: number;
};

export function createQuantileScale(
  options: QuantileOptions = {},
): QuantileScale {
  const capacity = options.capacity ?? 4096;
  const minSamples = options.minSamples ?? 64;

  const ring = new Float64Array(capacity);
  let writeIndex = 0;
  let filled = 0;

  /** Sorted snapshot. Rebuilt on demand; read by every lookup. */
  let sorted = new Float64Array(0);

  return {
    push(value) {
      if (!Number.isFinite(value)) return;
      ring[writeIndex] = value;
      writeIndex = (writeIndex + 1) % capacity;
      if (filled < capacity) filled += 1;
    },

    rebuild() {
      if (filled === 0) {
        sorted = new Float64Array(0);
        return;
      }
      const next = ring.slice(0, filled);
      next.sort();
      sorted = next;
    },

    percentile(value) {
      const n = sorted.length;
      if (n === 0) return 0.5; // no window yet: mid-ramp is the honest default

      // Lower bound: index of the first element >= value.
      let low = 0;
      let high = n;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (sorted[mid] < value) low = mid + 1;
        else high = mid;
      }
      return low / n;
    },

    valueAt(p) {
      const n = sorted.length;
      if (n === 0) return 0;
      const index = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
      return sorted[index];
    },

    size: () => filled,
    ready: () => filled >= minSamples,
  };
}
