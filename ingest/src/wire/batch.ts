/**
 * The txs batch. Pure: the timer that calls `flush`
 * lives in the composition root, so a test can push and flush by hand.
 *
 * Bounded: past `max` entries the oldest are dropped and counted. A batch
 * that grew without bound during a client-side stall would be a memory leak
 * with a good excuse.
 */
export type Batch<T> = {
  push(item: T): void;
  /** Everything since the last flush, oldest first. Empties the batch. */
  flush(): T[];
  size(): number;
  /** Entries dropped because the batch was full. Never resets. */
  drops(): number;
};

export function createBatch<T>(options: { max: number }): Batch<T> {
  const { max } = options;
  if (!(max >= 1)) throw new Error("batch: max must be >= 1");
  let items: T[] = [];
  let drops = 0;
  return {
    push(item) {
      items.push(item);
      if (items.length > max) {
        items.shift();
        drops += 1;
      }
    },
    flush() {
      const out = items;
      items = [];
      return out;
    },
    size: () => items.length,
    drops: () => drops,
  };
}
