/**
 * A fake provider for the integration tests: the WebSocket server speaking
 * just enough JSON-RPC, answering receipts and headers from a scripted chain
 * (block n has hash H(n), parent H(n-1), two receipts), able to push pending
 * transactions and heads, and to drop every connection on command.
 */
import type { CoreConfig } from "../../src/config.ts";
import { startWsServer, type WsConnection, type WsServer } from "./ws-server.ts";

export const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
export const T = (n: number) => `0x${(0xaaaa + n).toString(16).padStart(64, "0")}`;

export function head(n: number) {
  return {
    number: `0x${n.toString(16)}`,
    hash: H(n),
    parentHash: H(n - 1),
    baseFeePerGas: "0x3b9aca00",
    timestamp: `0x${(1_700_000_000 + 12 * n).toString(16)}`,
    gasUsed: "0x5208",
  };
}

export function receipts(n: number) {
  return [0, 1].map((i) => ({
    transactionHash: T(n * 10 + i),
    transactionIndex: `0x${i}`,
    gasUsed: "0x5208",
    effectiveGasPrice: "0x3b9aca01",
    blockHash: H(n),
  }));
}

export type FakeProvider = WsServer & {
  subscribeCalls: string[];
  emitPending(tx: unknown): void;
  emitHead(n: number): void;
  unknownHeaders: Set<string>;
  /** Open connections right now. */
  openConnections(): number;
};

export async function startFakeProvider(): Promise<FakeProvider> {
  const subscribeCalls: string[] = [];
  const subs = new Map<WsConnection, { pending?: string; heads?: string }>();
  const unknownHeaders = new Set<string>();
  let nextSub = 1;
  const server = await startWsServer({
    onMessage(conn, text) {
      const m = JSON.parse(text);
      const reply = (result: unknown) => conn.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      if (m.method === "eth_subscribe") {
        const id = `0x${(nextSub++).toString(16)}`;
        const s = subs.get(conn) ?? {};
        if (m.params[0] === "newPendingTransactions") s.pending = id;
        if (m.params[0] === "newHeads") s.heads = id;
        subs.set(conn, s);
        subscribeCalls.push(m.params[0]);
        reply(id);
      } else if (m.method === "eth_getBlockReceipts") {
        reply(receipts(Number.parseInt(m.params[0].slice(-4), 16)));
      } else if (m.method === "eth_getBlockByHash") {
        if (unknownHeaders.has(m.params[0])) reply(null);
        else reply(head(Number.parseInt(m.params[0].slice(-4), 16)));
      } else reply(null);
    },
  });
  const notify = (kind: "pending" | "heads", result: unknown) => {
    for (const [conn, s] of subs) {
      const id = s[kind];
      if (id && conn.open) conn.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: id, result } }));
    }
  };
  const dropSockets = server.dropAll;
  return Object.assign(server, {
    subscribeCalls,
    unknownHeaders,
    emitPending: (tx: unknown) => notify("pending", tx),
    emitHead: (n: number) => notify("heads", head(n)),
    openConnections: () => server.connections().filter((c) => c.open).length,
    dropAll() {
      dropSockets();
      subs.clear();
    },
  });
}

/** Reads SSE messages from a fetch Response as parsed `{id, data}` pairs. */
export function sseReader(res: Response) {
  const r = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const queue: { id: number | null; data: unknown; comment?: string }[] = [];
  let ended = false;
  const next = async (timeoutMs = 3000): Promise<{ id: number | null; data: unknown }> => {
    const deadline = Date.now() + timeoutMs;
    while (queue.length === 0) {
      if (ended) throw new Error("stream ended");
      if (Date.now() > deadline) throw new Error("no frame within timeout");
      const { value, done } = await r.read();
      if (done) {
        ended = true;
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const message = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let id: number | null = null;
        let data: string | null = null;
        for (const line of message.split("\n")) {
          if (line.startsWith("id: ")) id = Number(line.slice(4));
          if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (data !== null) queue.push({ id, data: JSON.parse(data) });
      }
    }
    return queue.shift()!;
  };
  /** Resolves when the server ends the stream. */
  const untilEnd = async (timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!ended) {
      if (Date.now() > deadline) throw new Error("stream did not end in time");
      const { done } = await r.read();
      if (done) ended = true;
    }
  };
  return { next, untilEnd };
}

export const waitFor = async (pred: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A complete CoreConfig for tests: fast timers, small caps, always-on unless overridden. */
export function testConfig(url: string, overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    upstreamUrls: [url],
    blocksUrls: null,
    poolTtlMs: 300_000,
    poolMax: 10_000,
    batchIntervalMs: 20,
    maxBatchTxs: 100,
    receiptsDelayMs: 20,
    receiptsAttempts: 2,
    backfillMax: 10,
    reconnectMinMs: 50,
    keepaliveMs: 60_000,
    clientStallMs: 10_000,
    maxClients: 10,
    maxClientsPerIp: 3,
    replayMs: 60_000,
    headStaleMs: 36_000,
    pendingStaleMs: 30_000,
    idleStopMs: 0,
    streamMaxMs: 0,
    ...overrides,
  };
}
