/**
 * One line per event, `key=value`, to stdout. journald keeps and rotates it;
 * nothing here buffers, formats colours or ships anywhere.
 *
 * `once` rate-limits a line per key: a provider that sends ten thousand
 * malformed objects a minute should cost one line a minute, not ten thousand.
 */

export type Fields = Record<string, unknown>;

export type Logger = {
  line(kind: string, fields?: Fields): void;
  /** At most one line per `key` every `everyMs` (default one minute). */
  once(key: string, kind: string, fields?: Fields, everyMs?: number): void;
};

function render(value: unknown): string {
  if (value === null || value === undefined) return "-";
  const s = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
}

export function createLogger(
  write: (line: string) => void = (s) => {
    process.stdout.write(s);
  },
  now: () => number = Date.now,
): Logger {
  const last = new Map<string, number>();
  const line = (kind: string, fields: Fields = {}) => {
    const parts = [new Date(now()).toISOString(), `kind=${kind}`];
    for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${render(v)}`);
    write(parts.join(" ") + "\n");
  };
  return {
    line,
    once(key, kind, fields = {}, everyMs = 60_000) {
      const t = now();
      const previous = last.get(key);
      if (previous !== undefined && t - previous < everyMs) return;
      last.set(key, t);
      line(kind, fields);
    },
  };
}
