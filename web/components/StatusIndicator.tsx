import type { ConnectionState } from "@/components/Logo";

/**
 * Stream status.
 *
 * Extends the logo's connection states with two the chrome needs and the logo
 * has no visual for:
 *
 * · `down` — the stream is gone (--dead).
 * · `calibrating` — connected and receiving, but not yet able to tell private
 *   flow from a transaction that predates the connection (--calib).
 *   `connecting` would be wrong here: we are connected, and the thing still
 *   in progress is our own confidence, not the socket.
 * · `simulated` — the numbers are coming from the synthetic generator, not
 *   from Ethereum (--calib).
 * · `loading` — a recording is being fetched. `connecting` would be wrong: a
 *   recording is a file, and a page that says it is connecting to one has
 *   misdescribed what it is doing (--calib, pulsing).
 * · `recorded` — the numbers are real and not current: a recording of the
 *   chain, replayed. Solid, in the numeral colour: a measurement, and not
 *   the green that means now.
 * · `reconnecting` — the socket dropped and the browser is retrying. Said
 *   the moment the source knows, not after enough silence to call it stale:
 *   for those seconds the page would otherwise say "live" over nothing
 *   (--calib, pulsing).
 *
 * `simulated` and `recorded` are not connection states, and they outrank
 * `live` on purpose.
 * A green dot reading LIVE is a claim that what is on screen is the chain. It
 * was making that claim over a seeded PRNG, with nothing anywhere on the page
 * to say otherwise — the source name existed only in a `console.log` behind a
 * debug flag. Health and provenance are different questions, and when the
 * answer to the second is "none of this is real" it is the one worth the dot.
 */
export type StreamStatus =
  | ConnectionState
  | "down"
  | "calibrating"
  | "simulated"
  | "loading"
  | "recorded"
  | "reconnecting";

const LABELS: Record<StreamStatus, string> = {
  idle: "idle",
  connecting: "connecting",
  calibrating: "calibrating",
  live: "live",
  down: "no signal",
  simulated: "simulated data",
  loading: "loading recording",
  recorded: "recorded",
  reconnecting: "reconnecting",
};

export type StatusIndicatorProps = {
  status?: StreamStatus;
  /** A qualifier after the label — "loading recording · 62%". */
  detail?: string;
  className?: string;
};

/** Instrument-style status readout: a dot plus its label. */
export function StatusIndicator({
  status = "idle",
  detail,
  className,
}: StatusIndicatorProps) {
  return (
    <span
      className={`inline-flex items-center gap-2 ${className ?? ""}`}
      role="status"
    >
      <span className="df-status-dot" data-status={status} aria-hidden="true" />
      <span className="label">
        {LABELS[status]}
        {detail ? ` · ${detail}` : null}
      </span>
    </span>
  );
}

export default StatusIndicator;
