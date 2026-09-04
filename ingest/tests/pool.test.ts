import { describe, expect, it } from "vitest";
import type { Hex } from "../../web/types/stream.ts";
import { createPool } from "../src/pool.ts";

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

describe("pool", () => {
  it("remembers a hash once", () => {
    const p = createPool({ ttlMs: 1000, max: 10 });
    expect(p.add(h(1), 0)).toBe(true);
    expect(p.add(h(1), 5)).toBe(false);
    expect(p.has(h(1))).toBe(true);
    expect(p.size()).toBe(1);
  });

  it("forgets by age, oldest first, and stops at the first live entry", () => {
    const p = createPool({ ttlMs: 1000, max: 10 });
    p.add(h(1), 0);
    p.add(h(2), 500);
    p.add(h(3), 1200);
    expect(p.prune(1400)).toBe(1); // only h(1): 1400 - 1000 = 400 > 0
    expect(p.has(h(1))).toBe(false);
    expect(p.has(h(2))).toBe(true);
    expect(p.prune(1600)).toBe(1);
    expect(p.size()).toBe(1);
    expect(p.capEvictions()).toBe(0);
  });

  it("counts every eviction the cap forces before the TTL could", () => {
    const p = createPool({ ttlMs: 60_000, max: 2 });
    p.add(h(1), 0);
    p.add(h(2), 1);
    p.add(h(3), 2);
    expect(p.size()).toBe(2);
    expect(p.has(h(1))).toBe(false);
    expect(p.capEvictions()).toBe(1);
    p.add(h(4), 3);
    expect(p.capEvictions()).toBe(2);
  });
});
