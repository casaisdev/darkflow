/**
 * The fan-out. Knows nothing of HTTP: a
 * client is anything with `write`, `end` and a drain signal, which is what a
 * test hands it and what `vercel.ts` wraps a `ReadableStream` into.
 *
 * Every frame is serialised once, given a monotonically increasing id, kept
 * for `replayMs`, and written to every client as `id: N` + the payload. A
 * client that reconnects with the last id it saw gets what it missed, if the
 * buffer still has it; `EventSource` sends that id on its own.
 *
 * A client whose socket stops draining is given `stallMs` and then closed:
 * one slow reader must not hold a copy of every frame in this process's
 * memory. One address may hold at most `maxClientsPerIp` streams. A
 * keepalive comment every `keepaliveMs` keeps proxies from closing an idle
 * stream.
 */
export type Client = {
  /** Returns `false` when the underlying socket is back-pressured. */
  write(chunk: string): boolean;
  end(): void;
  /** Called with the callback to run when the socket drains again. */
  onDrain(callback: () => void): void;
};

export type AddResult =
  | { status: "ok"; replayed: number | null }
  | { status: "full" }
  | { status: "ip-limit" };

export type Hub = {
  /** Whether `add` would admit a client from this address right now. */
  admission(ip: string): "ok" | "full" | "ip-limit";
  /** `lastEventId` is the id the client last saw, when it says so. */
  add(client: Client, now: number, options: { ip: string; lastEventId?: number | null }): AddResult;
  remove(client: Client): void;
  /** `payload` is one SSE message without an id line ("data: ...\n\n"). */
  broadcast(payload: string, now: number): number;
  /** Keepalive and stall eviction. Call about once a second. */
  tick(now: number): { keepalive: boolean; evicted: number };
  clients(): number;
  framesSent(): number;
  evictions(): number;
  lastId(): number;
  buffered(): number;
  /** Reconnects served from the buffer, and the frames they were given. */
  replays(): { clients: number; frames: number };
};

type Entry = { client: Client; ip: string; stalledSince: number | null };
type Buffered = { id: number; at: number; text: string };

export function createHub(options: {
  keepaliveMs: number;
  stallMs: number;
  maxClients: number;
  maxClientsPerIp?: number;
  replayMs?: number;
}): Hub {
  const { keepaliveMs, stallMs, maxClients, maxClientsPerIp = Number.POSITIVE_INFINITY, replayMs = 0 } = options;
  const entries = new Map<Client, Entry>();
  const perIp = new Map<string, number>();
  const buffer: Buffered[] = [];
  let nextId = 1;
  let framesSent = 0;
  let evictions = 0;
  let lastKeepalive = Number.NEGATIVE_INFINITY;
  let replayClients = 0;
  let replayFrames = 0;

  function writeTo(entry: Entry, chunk: string, now: number): void {
    let ok: boolean;
    try {
      ok = entry.client.write(chunk);
    } catch {
      ok = false;
    }
    if (ok) entry.stalledSince = null;
    else if (entry.stalledSince === null) entry.stalledSince = now;
  }

  function drop(entry: Entry): void {
    entries.delete(entry.client);
    const n = (perIp.get(entry.ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(entry.ip);
    else perIp.set(entry.ip, n);
  }

  function trim(now: number): void {
    const cutoff = now - replayMs;
    while (buffer.length > 0 && buffer[0]!.at < cutoff) buffer.shift();
  }

  function admission(ip: string): "ok" | "full" | "ip-limit" {
    if (entries.size >= maxClients) return "full";
    if ((perIp.get(ip) ?? 0) >= maxClientsPerIp) return "ip-limit";
    return "ok";
  }

  return {
    admission,
    add(client, now, { ip, lastEventId = null }) {
      const verdict = admission(ip);
      if (verdict !== "ok") return { status: verdict };
      const entry: Entry = { client, ip, stalledSince: null };
      entries.set(client, entry);
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      client.onDrain(() => {
        entry.stalledSince = null;
      });
      if (lastKeepalive === Number.NEGATIVE_INFINITY) lastKeepalive = now;

      let replayed: number | null = null;
      if (lastEventId !== null && Number.isInteger(lastEventId) && lastEventId >= 0) {
        trim(now);
        const oldest = buffer[0];
        // Replay only when the client's last id is still inside the buffer's
        // reach (it saw the id just before our oldest, or later). A client
        // that has been away longer gets the live stream and nothing false.
        if (oldest !== undefined && lastEventId >= oldest.id - 1) {
          replayed = 0;
          for (const frame of buffer) {
            if (frame.id > lastEventId) {
              writeTo(entry, frame.text, now);
              replayed += 1;
            }
          }
          replayClients += 1;
          replayFrames += replayed;
        } else if (oldest === undefined && lastEventId >= nextId - 1) {
          replayed = 0;
        }
      }
      return { status: "ok", replayed };
    },
    remove(client) {
      const entry = entries.get(client);
      if (entry) drop(entry);
    },
    broadcast(payload, now) {
      const id = nextId++;
      const text = `id: ${id}\n${payload}`;
      framesSent += 1;
      if (replayMs > 0) {
        buffer.push({ id, at: now, text });
        trim(now);
      }
      for (const entry of entries.values()) writeTo(entry, text, now);
      return id;
    },
    tick(now) {
      let keepalive = false;
      if (entries.size > 0 && now - lastKeepalive >= keepaliveMs) {
        keepalive = true;
        lastKeepalive = now;
        for (const entry of entries.values()) writeTo(entry, ": keepalive\n\n", now);
      }
      let evicted = 0;
      for (const entry of [...entries.values()]) {
        if (entry.stalledSince !== null && now - entry.stalledSince >= stallMs) {
          drop(entry);
          evicted += 1;
          evictions += 1;
          try {
            entry.client.end();
          } catch {
            // The socket is already gone; that is what we wanted.
          }
        }
      }
      trim(now);
      return { keepalive, evicted };
    },
    clients: () => entries.size,
    framesSent: () => framesSent,
    evictions: () => evictions,
    lastId: () => nextId - 1,
    buffered: () => buffer.length,
    replays: () => ({ clients: replayClients, frames: replayFrames }),
  };
}
