/**
 * JSON-RPC over a WebSocket, with the three things a long-lived upstream
 * needs and a provider SDK would hide: id correlation with timeouts,
 * subscription routing that survives reconnects, and reconnection with a
 * capped, jittered backoff that rotates through the configured URLs.
 *
 * Knows nothing about Ethereum. The WebSocket class and the clock are
 * injectable so the whole thing runs under a fake in tests.
 */
import type { LinkState } from "./types.ts";

export type RpcOptions = {
  urls: string[];
  onNotification(subscription: string, result: unknown): void;
  onLink(state: LinkState, detail?: string): void;
  /** Injection points for tests. */
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
  random?: () => number;
  callTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** Consecutive failed connects before the next URL is tried. */
  failuresBeforeRotate?: number;
};

export type Rpc = {
  call(method: string, params: unknown[]): Promise<unknown>;
  /**
   * Registers a subscription that is (re)established on every connection.
   * Returns a local key; notifications for it arrive under that key.
   */
  subscribe(method: string, params: unknown[]): string;
  close(): void;
  url(): string;
  state(): LinkState;
  /** Failed connection attempts since the last successful open. */
  failures(): number;
};

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export function createRpc(options: RpcOptions): Rpc {
  const {
    urls,
    onNotification,
    onLink,
    WebSocketImpl = WebSocket,
    now = Date.now,
    random = Math.random,
    callTimeoutMs = 10_000,
    backoffMinMs = 1_000,
    backoffMaxMs = 30_000,
    failuresBeforeRotate = 3,
  } = options;
  if (urls.length === 0) throw new Error("rpc: no urls");

  let socket: WebSocket | null = null;
  let state: LinkState = "closed";
  let closedByUs = false;
  let urlIndex = 0;
  let consecutiveFailures = 0;
  let nextId = 1;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const inflight = new Map<number, Pending>();
  /** What we want subscribed, by local key. */
  const desired = new Map<string, { method: string; params: unknown[] }>();
  /** Remote subscription id → local key, for the current connection only. */
  const remoteToLocal = new Map<string, string>();
  let nextLocalKey = 1;

  function send(payload: unknown): boolean {
    if (!socket || socket.readyState !== 1 /* OPEN */) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  function failAllInflight(reason: string): void {
    for (const [id, p] of inflight) {
      clearTimeout(p.timer);
      p.reject(new Error(`rpc: ${reason}`));
      inflight.delete(id);
    }
  }

  function call(method: string, params: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        inflight.delete(id);
        reject(new Error(`rpc: ${method} timed out after ${callTimeoutMs}ms`));
      }, callTimeoutMs);
      inflight.set(id, { resolve, reject, timer });
      if (!send({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(timer);
        inflight.delete(id);
        reject(new Error(`rpc: ${method} while link is ${state}`));
      }
    });
  }

  /** Subscribe requests in flight, by JSON-RPC id → local key. */
  const subscribing = new Map<number, string>();

  /**
   * Sends the eth_subscribe for a local key. Its answer is handled inline in
   * `handleMessage`, not through `call()`: the remote id must be known the
   * instant the response is parsed, because the first notification can be
   * the very next message on the socket.
   */
  function establish(localKey: string): void {
    const sub = desired.get(localKey);
    if (!sub) return;
    const id = nextId++;
    subscribing.set(id, localKey);
    if (!send({ jsonrpc: "2.0", id, method: sub.method, params: sub.params })) subscribing.delete(id);
  }

  function handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === "number" && subscribing.has(msg.id)) {
      const localKey = subscribing.get(msg.id)!;
      subscribing.delete(msg.id);
      if (typeof msg.result === "string") remoteToLocal.set(msg.result, localKey);
      else onLink(state, `subscribe ${localKey}: ${JSON.stringify(msg.error ?? msg.result)}`);
      return;
    }
    if (typeof msg.id === "number" && inflight.has(msg.id)) {
      const p = inflight.get(msg.id)!;
      inflight.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error !== undefined) p.reject(new Error(`rpc: ${JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "eth_subscription" && typeof msg.params === "object" && msg.params !== null) {
      const params = msg.params as Record<string, unknown>;
      const local = typeof params.subscription === "string" ? remoteToLocal.get(params.subscription) : undefined;
      if (local !== undefined) onNotification(local, params.result);
    }
  }

  function scheduleReconnect(detail: string): void {
    if (closedByUs || reconnectTimer) return;
    consecutiveFailures += 1;
    if (consecutiveFailures % failuresBeforeRotate === 0 && urls.length > 1) {
      urlIndex = (urlIndex + 1) % urls.length;
    }
    const exponent = Math.min(consecutiveFailures - 1, 10);
    const base = Math.min(backoffMaxMs, backoffMinMs * 2 ** exponent);
    const delay = Math.round(base * (0.5 + random() * 0.5));
    state = "reconnecting";
    onLink("reconnecting", `${detail}; retry in ${delay}ms via ${urls[urlIndex]}`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect(): void {
    if (closedByUs) return;
    const url = urls[urlIndex]!;
    let ws: WebSocket;
    try {
      ws = new WebSocketImpl(url);
    } catch (error) {
      scheduleReconnect(`connect threw: ${(error as Error).message}`);
      return;
    }
    socket = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      consecutiveFailures = 0;
      state = "open";
      remoteToLocal.clear();
      onLink("open", url);
      for (const key of desired.keys()) establish(key);
    };
    ws.onmessage = (event: MessageEvent) => handleMessage(event.data);
    ws.onerror = () => {
      // The close event follows; the reason is reported there.
    };
    ws.onclose = (event: CloseEvent) => {
      if (socket !== ws) return;
      socket = null;
      remoteToLocal.clear();
      subscribing.clear();
      failAllInflight("link lost");
      if (closedByUs) {
        state = "closed";
        onLink("closed", "closed by us");
        return;
      }
      scheduleReconnect(opened ? `closed (${event.code})` : `connect failed (${event.code})`);
    };
  }

  connect();

  return {
    call,
    subscribe(method, params) {
      const key = `sub-${nextLocalKey++}`;
      desired.set(key, { method, params });
      if (state === "open") establish(key);
      return key;
    },
    close() {
      closedByUs = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      failAllInflight("closed");
      if (socket) socket.close();
      else {
        state = "closed";
        onLink("closed", "closed by us");
      }
    },
    url: () => urls[urlIndex]!,
    state: () => state,
    failures: () => consecutiveFailures,
  };
}

// Unused-at-runtime reference so the clock injection point is honest: the
// backoff uses real timers, the tests use fake ones; `now` is kept for the
// day a caller wants to stamp link events.
void ((): number => Date.now());
