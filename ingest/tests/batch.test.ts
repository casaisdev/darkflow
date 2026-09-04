import { describe, expect, it } from "vitest";
import { createBatch } from "../src/wire/batch.ts";

describe("batch", () => {
  it("returns everything since the last flush, oldest first, then empties", () => {
    const b = createBatch<number>({ max: 10 });
    b.push(1);
    b.push(2);
    expect(b.size()).toBe(2);
    expect(b.flush()).toEqual([1, 2]);
    expect(b.size()).toBe(0);
    expect(b.flush()).toEqual([]);
  });

  it("drops the oldest past the cap and counts every drop", () => {
    const b = createBatch<number>({ max: 3 });
    for (let i = 1; i <= 5; i++) b.push(i);
    expect(b.flush()).toEqual([3, 4, 5]);
    expect(b.drops()).toBe(2);
    b.push(6);
    expect(b.drops()).toBe(2);
  });

  it("refuses a cap below one", () => {
    expect(() => createBatch({ max: 0 })).toThrow();
  });
});
