import type { CalibrationState } from "@/lib/seen";

/**
 * The warm-up readout.
 *
 * During calibration the app cannot tell private flow from a transaction that
 * was already in the pool before it connected. Rather than guess and mark
 * everything amber — which would be the largest lie this application is capable
 * of telling — it shows how far along it is and marks nothing.
 *
 * Showing the uncertainty is the design, not an apology for it.
 */
export type CalibrationBarProps = {
  calibration: CalibrationState;
  /**
   * Whether the source is expected to hand over the pool on open.
   *
   * No source expects one today. The live ingest never sends a snapshot —
   * a provider has no pool to hand over, and its own memory must not be
   * passed off as one — and the recording was
   * captured from such an ingest, so it has none either. The synthetic
   * generator does snapshot, but says "simulated" beside it. The prop and
   * the wording stay for a source that can: the bar must never say it is
   * waiting for something that is not coming.
   */
  expectsSnapshot?: boolean;
};

/**
 * What the bar says while it waits.
 *
 * Exported for the test, and because the sentence changed once already
 * without anyone reading it in a browser.
 */
export function calibrationLabel(
  state: CalibrationState,
  expectsSnapshot: boolean,
): string {
  const observed = Math.min(state.blocksObserved, state.warmupBlocks);
  return expectsSnapshot
    ? `Waiting for the pool snapshot · block ${observed}/${state.warmupBlocks} without it`
    : `Calibrating · Block ${observed}/${state.warmupBlocks}`;
}

export function CalibrationBar({
  calibration,
  expectsSnapshot = false,
}: CalibrationBarProps) {
  if (!calibration.active) return null;

  const { blocksObserved, warmupBlocks } = calibration;
  const progress = Math.min(1, blocksObserved / Math.max(1, warmupBlocks));

  return (
    <div className="df-calib-bar" role="status" aria-live="polite">
      <div
        className="df-calib-fill"
        style={{ width: `${(progress * 100).toFixed(1)}%` }}
        aria-hidden="true"
      />
      <span className="label">{calibrationLabel(calibration, expectsSnapshot)}</span>
      {/* Dropped below lg: the sentence is wider than a phone, and the count
          beside it already says what state the instrument is in. */}
      <span className="label hidden opacity-70 lg:inline">
        {expectsSnapshot
          ? "Nothing marked as private flow until the ingest hands over the pool, or five blocks have been watched"
          : "Nothing marked as private flow until the mempool has been watched long enough to tell"}
      </span>
    </div>
  );
}

/**
 * How the calibration ended, once it has.
 *
 * A snapshot and a block count are different kinds of confidence: the ingest
 * handing over the pool answers the question outright, whereas waiting five
 * blocks only narrows it and leaves the long tail of old pending transactions
 * able to produce a false ghost. The instrument should not present them as the
 * same thing.
 */
export function calibrationSummary(state: CalibrationState): string | null {
  switch (state.closedBy) {
    case "snapshot":
      return "seeded from pool snapshot";
    case "blocks":
      return `warmed over ${state.warmupBlocks} blocks`;
    default:
      return null;
  }
}

export default CalibrationBar;
