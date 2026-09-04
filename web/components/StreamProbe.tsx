"use client";

import { useEffect } from "react";
import { activeSourceName, subscribe } from "@/lib/stream";
import { createSeenSet } from "@/lib/seen";
import { effectivePriorityFee } from "@/lib/fees";

const GWEI = 1e9;

/** Percentile of an already-sorted array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index];
}

/**
 * Exercises the two pure functions whose failure modes are silent: age
 * eviction (wrong and the set grows without bound, or evicts the living) and
 * the effective tip (wrong and the whole luminance ramp ranks by the wrong
 * number). Runs in the real browser against the real modules.
 */
function selfCheck(): void {
  const results: string[] = [];
  const check = (label: string, ok: boolean, detail = "") =>
    results.push(`${ok ? "ok  " : "FAIL"} ${label}${detail ? "  " + detail : ""}`);

  // --- age eviction -------------------------------------------------------
  const now = 1_000_000;
  const set = createSeenSet({ ttlMs: 1000 });
  const fees = { kind: "eip1559", maxPriorityFeePerGas: 0, maxFeePerGas: 0 } as const;
  const rec = (firstSeen: number) => ({
    firstSeen,
    fees,
    gas: 21000,
    included: false,
  });
  set.add("0xold", rec(now - 5000));
  set.add("0xedge", rec(now - 1000)); // at the cutoff: keep
  set.add("0xfresh", rec(now - 10));
  check("seen holds 3 before prune", set.size() === 3);
  set.prune(now);
  check("stale hash evicted", !set.has("0xold"));
  check("hash exactly at TTL kept", set.has("0xedge"));
  check("fresh hash kept", set.has("0xfresh"));
  check("size after prune is 2", set.size() === 2);

  // Re-announcing must not refresh age, or a chatty hash never expires.
  const reannounce = createSeenSet({ ttlMs: 1000 });
  reannounce.add("0xa", rec(now - 5000));
  reannounce.add("0xa", rec(now)); // ignored
  reannounce.prune(now);
  check("re-announce does not refresh age", !reannounce.has("0xa"));

  // The pending count must track the pool, not the map size.
  const pool = createSeenSet({ ttlMs: 1000 });
  pool.add("0xp1", rec(now));
  pool.add("0xp2", rec(now));
  check("pending counts announcements", pool.pending() === 2, String(pool.pending()));
  pool.markIncluded("0xp1");
  check("inclusion leaves the pool but keeps the record",
    pool.pending() === 1 && pool.has("0xp1"), String(pool.pending()));
  pool.markIncluded("0xp1");
  check("double inclusion does not double-count", pool.pending() === 1);
  pool.prune(now + 5000);
  check("pruning a pending tx removes it from the count", pool.pending() === 0);

  // --- effective tip ------------------------------------------------------
  const base = 10 * GWEI;
  check(
    "1559 tip capped by the fee ceiling",
    effectivePriorityFee(
      { kind: "eip1559", maxPriorityFeePerGas: 50 * GWEI, maxFeePerGas: 12 * GWEI },
      base,
    ) ===
      2 * GWEI,
  );
  check(
    "1559 tip uncapped when the ceiling is generous",
    effectivePriorityFee(
      { kind: "eip1559", maxPriorityFeePerGas: 2 * GWEI, maxFeePerGas: 99 * GWEI },
      base,
    ) ===
      2 * GWEI,
  );
  check(
    "legacy tip is gasPrice over base",
    effectivePriorityFee({ kind: "legacy", gasPrice: 13 * GWEI }, base) ===
      3 * GWEI,
  );
  check(
    "underpriced tx clamps to zero, never negative",
    effectivePriorityFee({ kind: "legacy", gasPrice: 4 * GWEI }, base) === 0,
  );

  const failed = results.filter((r) => r.startsWith("FAIL"));
  console.log(`[probe] self-check\n${results.join("\n")}`);
  if (failed.length > 0) {
    console.error(`[probe] ${failed.length} SELF-CHECK FAILURE(S)`);
  }
}

/**
 * Console-only consumer, for verifying the data layer before anything draws.
 * Renders nothing. Opt in with `?probe=1`.
 *
 * Two things are being checked here, and both have to hold before any pixel is
 * worth drawing:
 *
 * 1. **The ghost ratio.** What the classifier reports per block against what
 *    the synthetic source was told to generate (10–40%). If those disagree, the
 *    product's one claim is wrong and everything on top of it is decoration on
 *    a lie.
 * 2. **The fee distribution.** p50 and p99 of the effective tip should be far
 *    apart. A uniform distribution would make Phase 3's percentile ramp look
 *    linear and hide the reason it exists.
 *
 * Phase 2 replaces this with the real canvas consumer; it stays behind the
 * query param as a debugging tool.
 */
export function StreamProbe() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("probe") !== "1") {
      return;
    }

    selfCheck();

    const seen = createSeenSet();
    /** Until the first block there is no base fee, so tips cannot be resolved. */
    let baseFeePerGas: number | null = null;
    let tipSamples: number[] = [];
    let txCount = 0;
    let batchCount = 0;
    let windowStart = performance.now();

    console.log(`[probe] source=${activeSourceName()}`);

    const unsubscribe = subscribe(
      (txs, meta) => {
        if (meta.snapshot) {
          seen.seedFromSnapshot(txs);
          console.log(
            `[probe] snapshot: ${txs.length} tx seeded · warm=${seen.isWarm()}`,
          );
          return;
        }

        seen.addMany(txs);
        txCount += txs.length;
        batchCount += 1;

        if (baseFeePerGas !== null) {
          for (const tx of txs) {
            tipSamples.push(effectivePriorityFee(tx.fees, baseFeePerGas));
          }
        }

        const elapsed = performance.now() - windowStart;
        if (elapsed >= 2000) {
          seen.prune(Date.now());
          const sorted = [...tipSamples].sort((a, b) => a - b);
          const spread =
            sorted.length > 0
              ? ` · tip p50 ${(percentile(sorted, 0.5) / GWEI).toFixed(2)} ` +
                `p90 ${(percentile(sorted, 0.9) / GWEI).toFixed(2)} ` +
                `p99 ${(percentile(sorted, 0.99) / GWEI).toFixed(2)} gwei ` +
                `(x${(percentile(sorted, 0.99) / Math.max(1, percentile(sorted, 0.5))).toFixed(1)} tail)`
              : "";
          console.log(
            `[probe] ${(txCount / (elapsed / 1000)).toFixed(0)} tx/s · ` +
              `${(batchCount / (elapsed / 1000)).toFixed(1)} batch/s · ` +
              `seen=${seen.size()}${spread}`,
          );
          txCount = 0;
          batchCount = 0;
          tipSamples = [];
          windowStart = performance.now();
        }
      },
      (block) => {
        seen.noteBlock();
        baseFeePerGas = block.baseFeePerGas;

        const ghosts = block.hashes.filter((hash) => seen.isGhost(hash));
        const ratio = ghosts.length / block.hashes.length;

        // The number that decides whether the product is honest: what the
        // classifier concluded against what the generator actually did.
        const truth = globalThis.__darkflowSyntheticTruth;
        let verdict = "";
        if (truth && truth.blockNumber === block.number) {
          const drift = ghosts.length - truth.intendedGhosts;
          verdict =
            drift === 0
              ? " · EXACT"
              : ` · DRIFT ${drift > 0 ? "+" : ""}${drift} ` +
                `(intended ${truth.intendedGhosts}, reported ${ghosts.length})`;
          if (drift !== 0) {
            console.error(
              `[probe] classifier disagrees with the generator by ${drift} tx on block ${block.number}. ` +
                `Positive drift means the seen-set forgot transactions that were still pending.`,
            );
          }
        }

        console.log(
          `[probe] block ${block.number} · ${block.hashes.length} tx · ` +
            `ghosts ${ghosts.length} (${(ratio * 100).toFixed(1)}%)${verdict} · ` +
            `warm=${seen.isWarm()} ` +
            `(${seen.blocksObserved()}/${seen.warmupBlocks()}` +
            `${seen.seededBySnapshot() ? ", snapshot" : ""}) · ` +
            `baseFee ${(block.baseFeePerGas / GWEI).toFixed(2)} gwei · ` +
            `seen=${seen.size()} · evicted=${seen.capacityEvictions()}`,
        );
      },
    );

    return unsubscribe;
  }, []);

  return null;
}

export default StreamProbe;
