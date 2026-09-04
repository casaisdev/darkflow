import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRecording, type Recording } from "@/lib/replay/format";

/**
 * The recordings the site ships, as data: each must validate whole, and
 * the one made after the wire grew `tips` must carry them on every block —
 * a block without them plays its ghosts at the floor, which is the picture
 * this recording exists to replace.
 */
/** The shipped recording lives in public/; the older one, kept for the axis-stability test, in tests/fixtures/. */
const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name.includes("08-27") ? `./fixtures/${name}` : `../public/replay/${name}`, import.meta.url), "utf8"));

describe("the recordings", () => {
  it("validate whole", () => {
    for (const name of ["mainnet-2026-08-27.json", "mainnet-2026-09-03.json"]) {
      expect(isRecording(load(name)), name).toBe(true);
    }
  });

  it("the 2026-09-03 recording carries a tip for every row of every block", () => {
    const recording = load("mainnet-2026-09-03.json") as Recording;
    const blocks = recording.frames.filter((f) => f.kind === "block");
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.tips, String(block.number)).toHaveLength(block.hashes.length);
    }
    // And says where it was heard from, so "this feed" can name itself.
    expect(recording.meta.sources.pending.length).toBeGreaterThan(0);
  });

  it("the 2026-08-27 recording predates tips and says so by their absence", () => {
    const recording = load("mainnet-2026-08-27.json") as Recording;
    const blocks = recording.frames.filter((f) => f.kind === "block");
    expect(blocks.every((b) => b.tips === undefined)).toBe(true);
  });
});
