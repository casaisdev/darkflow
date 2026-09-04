import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRpc } from "../src/source/rpc.ts";

/**
 * A WebSocket stand-in with the surface rpc.ts uses. Sockets are opened,
 * fed and dropped by the test; nothing here touches the network.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static refuse = false;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
    if (FakeSocket.refuse) queueMicrotask(() => this.drop(1006));
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.drop(1000);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  feed(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  /** Answers the last eth_subscribe with a remote id. */
  answerSubscribe(id: string) {
    const req = JSON.parse(this.sent.at(-1)!);
    this.feed({ jsonrpc: "2.0", id: req.id, result: id });
  }
}

const WS = FakeSocket as unknown as typeof WebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  FakeSocket.refuse = false;
});
afterEach(() => vi.useRealTimers());

describe("rpc", () => {
  it("correlates calls by id and rejects on a JSON-RPC error", async () => {
    const rpc = createRpc({ urls: ["wss://a"], onNotification: () => {}, onLink: () => {}, WebSocketImpl: WS });
    const s = FakeSocket.instances[0]!;
    s.open();
    const p1 = rpc.call("eth_chainId", []);
    const p2 = rpc.call("eth_getBlockReceipts", ["0x1"]);
    const [r1, r2] = s.sent.map((x) => JSON.parse(x));
    s.feed({ jsonrpc: "2.0", id: r2.id, result: [] });
    s.feed({ jsonrpc: "2.0", id: r1.id, error: { code: -32000, message: "nope" } });
    await expect(p2).resolves.toEqual([]);
    await expect(p1).rejects.toThrow(/nope/);
  });

  it("times out a call the upstream never answers", async () => {
    const rpc = createRpc({ urls: ["wss://a"], onNotification: () => {}, onLink: () => {}, WebSocketImpl: WS, callTimeoutMs: 500 });
    FakeSocket.instances[0]!.open();
    const p = rpc.call("eth_x", []);
    vi.advanceTimersByTime(600);
    await expect(p).rejects.toThrow(/timed out/);
  });

  it("routes notifications to the local subscription key", () => {
    const seen: [string, unknown][] = [];
    const rpc = createRpc({ urls: ["wss://a"], onNotification: (k, r) => seen.push([k, r]), onLink: () => {}, WebSocketImpl: WS });
    const s = FakeSocket.instances[0]!;
    s.open();
    const key = rpc.subscribe("eth_subscribe", ["newHeads"]);
    s.answerSubscribe("0xabc");
    s.feed({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0xabc", result: { number: "0x1" } } });
    s.feed({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0xzzz", result: {} } });
    expect(seen).toEqual([[key, { number: "0x1" }]]);
  });

  it("reconnects with backoff, re-establishes subscriptions and fails in-flight calls", async () => {
    const links: string[] = [];
    const rpc = createRpc({
      urls: ["wss://a"],
      onNotification: () => {},
      onLink: (state) => links.push(state),
      WebSocketImpl: WS,
      backoffMinMs: 1000,
      random: () => 1, // no jitter below the base
    });
    const first = FakeSocket.instances[0]!;
    first.open();
    rpc.subscribe("eth_subscribe", ["newHeads"]);
    first.answerSubscribe("0x1");
    const inflight = rpc.call("eth_x", []);
    first.drop(1006);
    await expect(inflight).rejects.toThrow(/link lost/);
    expect(links).toEqual(["open", "reconnecting"]);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1]!;
    second.open();
    expect(links.at(-1)).toBe("open");
    // The subscription was re-sent on the new socket without anyone asking.
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ method: "eth_subscribe", params: ["newHeads"] });
  });

  it("rotates to the next URL after repeated failures and caps the backoff", () => {
    FakeSocket.refuse = true;
    const rpc = createRpc({
      urls: ["wss://a", "wss://b"],
      onNotification: () => {},
      onLink: () => {},
      WebSocketImpl: WS,
      backoffMinMs: 1000,
      backoffMaxMs: 4000,
      failuresBeforeRotate: 2,
      random: () => 1,
    });
    return (async () => {
      await Promise.resolve(); // first refusal
      expect(rpc.state()).toBe("reconnecting");
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(rpc.url()).toBe("wss://b");
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      vi.advanceTimersByTime(4000);
      await Promise.resolve();
      vi.advanceTimersByTime(4000); // capped, not 8000
      await Promise.resolve();
      expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(5);
      expect(rpc.failures()).toBeGreaterThanOrEqual(4);
      rpc.close();
      expect(rpc.state()).toBe("closed");
    })();
  });

  it("does not reconnect after close()", () => {
    const links: string[] = [];
    const rpc = createRpc({ urls: ["wss://a"], onNotification: () => {}, onLink: (s) => links.push(s), WebSocketImpl: WS });
    FakeSocket.instances[0]!.open();
    rpc.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(links).toEqual(["open", "closed"]);
  });
});
