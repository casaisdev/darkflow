import { describe, expect, it } from "vitest";
import { createHub, type Client } from "../src/hub.ts";

function fakeClient(options: { accept?: () => boolean } = {}) {
  const written: string[] = [];
  let ended = false;
  let drain: (() => void) | null = null;
  const client: Client = {
    write(chunk) {
      written.push(chunk);
      return options.accept ? options.accept() : true;
    },
    end() {
      ended = true;
    },
    onDrain(cb) {
      drain = cb;
    },
  };
  return { client, written, ended: () => ended, drain: () => drain?.() };
}

const ip = { ip: "10.0.0.1" };

describe("hub", () => {
  it("writes each frame once to every client, with an increasing id, and counts frames not writes", () => {
    const hub = createHub({ keepaliveMs: 15_000, stallMs: 10_000, maxClients: 10 });
    const a = fakeClient();
    const b = fakeClient();
    hub.add(a.client, 0, ip);
    hub.add(b.client, 0, ip);
    expect(hub.broadcast("data: 1\n\n", 1)).toBe(1);
    expect(hub.broadcast("data: 2\n\n", 2)).toBe(2);
    expect(a.written).toEqual(["id: 1\ndata: 1\n\n", "id: 2\ndata: 2\n\n"]);
    expect(b.written).toEqual(a.written);
    expect(hub.framesSent()).toBe(2);
    hub.remove(a.client);
    hub.broadcast("data: 3\n\n", 3);
    expect(a.written).toHaveLength(2);
    expect(b.written).toHaveLength(3);
  });

  it("refuses a client past the cap, and past the per-address cap", () => {
    const hub = createHub({ keepaliveMs: 15_000, stallMs: 10_000, maxClients: 3, maxClientsPerIp: 2 });
    expect(hub.add(fakeClient().client, 0, { ip: "a" })).toEqual({ status: "ok", replayed: null });
    expect(hub.add(fakeClient().client, 0, { ip: "a" })).toEqual({ status: "ok", replayed: null });
    expect(hub.admission("a")).toBe("ip-limit");
    expect(hub.add(fakeClient().client, 0, { ip: "a" })).toEqual({ status: "ip-limit" });
    expect(hub.add(fakeClient().client, 0, { ip: "b" })).toEqual({ status: "ok", replayed: null });
    expect(hub.admission("c")).toBe("full");
    expect(hub.add(fakeClient().client, 0, { ip: "c" })).toEqual({ status: "full" });
    expect(hub.clients()).toBe(3);
  });

  it("frees an address's slot when its client leaves, however it leaves", () => {
    const hub = createHub({ keepaliveMs: 60_000, stallMs: 100, maxClients: 10, maxClientsPerIp: 1 });
    const a = fakeClient();
    hub.add(a.client, 0, { ip: "a" });
    expect(hub.admission("a")).toBe("ip-limit");
    hub.remove(a.client);
    expect(hub.admission("a")).toBe("ok");
    const slow = fakeClient({ accept: () => false });
    hub.add(slow.client, 0, { ip: "a" });
    hub.broadcast("data: x\n\n", 1);
    hub.tick(200);
    expect(hub.admission("a")).toBe("ok");
  });

  it("sends a keepalive comment on the interval, only while someone listens", () => {
    const hub = createHub({ keepaliveMs: 1_000, stallMs: 10_000, maxClients: 10 });
    expect(hub.tick(5_000).keepalive).toBe(false);
    const a = fakeClient();
    hub.add(a.client, 5_000, ip);
    expect(hub.tick(5_500).keepalive).toBe(false);
    expect(hub.tick(6_000).keepalive).toBe(true);
    expect(a.written).toEqual([": keepalive\n\n"]);
    expect(hub.tick(6_500).keepalive).toBe(false);
  });

  it("evicts a client that stays back-pressured past the stall limit, and only that one", () => {
    const hub = createHub({ keepaliveMs: 60_000, stallMs: 1_000, maxClients: 10 });
    const slow = fakeClient({ accept: () => false });
    const fine = fakeClient();
    hub.add(slow.client, 0, ip);
    hub.add(fine.client, 0, ip);
    hub.broadcast("data: x\n\n", 100);
    expect(hub.tick(900).evicted).toBe(0);
    expect(hub.tick(1_100).evicted).toBe(1);
    expect(slow.ended()).toBe(true);
    expect(fine.ended()).toBe(false);
    expect(hub.clients()).toBe(1);
    expect(hub.evictions()).toBe(1);
  });

  it("forgives a stall once the socket drains", () => {
    const hub = createHub({ keepaliveMs: 60_000, stallMs: 1_000, maxClients: 10 });
    let accept = false;
    const c = fakeClient({ accept: () => accept });
    hub.add(c.client, 0, ip);
    hub.broadcast("data: x\n\n", 100);
    accept = true;
    c.drain();
    expect(hub.tick(5_000).evicted).toBe(0);
    expect(c.ended()).toBe(false);
  });

  describe("replay", () => {
    it("gives a returning client the frames after the id it saw, within the window", () => {
      const hub = createHub({ keepaliveMs: 60_000, stallMs: 10_000, maxClients: 10, replayMs: 1_000 });
      hub.broadcast("data: 1\n\n", 100);
      hub.broadcast("data: 2\n\n", 200);
      hub.broadcast("data: 3\n\n", 300);
      const back = fakeClient();
      expect(hub.add(back.client, 400, { ip: "a", lastEventId: 1 })).toEqual({ status: "ok", replayed: 2 });
      expect(back.written).toEqual(["id: 2\ndata: 2\n\n", "id: 3\ndata: 3\n\n"]);
      expect(hub.buffered()).toBe(3);
      expect(hub.replays()).toEqual({ clients: 1, frames: 2 });
    });

    it("replays nothing, and says so, when the client was away longer than the window", () => {
      const hub = createHub({ keepaliveMs: 60_000, stallMs: 10_000, maxClients: 10, replayMs: 1_000 });
      hub.broadcast("data: 1\n\n", 100);
      hub.broadcast("data: 2\n\n", 5_000);
      hub.broadcast("data: 3\n\n", 5_100);
      // Frame 1 has aged out: a client that saw nothing cannot be given a
      // stream that starts at 2 as if 1 never happened.
      const back = fakeClient();
      expect(hub.add(back.client, 5_200, { ip: "a", lastEventId: 0 })).toEqual({ status: "ok", replayed: null });
      expect(back.written).toEqual([]);
      // A client that saw 1 is exactly at the buffer's edge and gets 2 and 3.
      const edge = fakeClient();
      expect(hub.add(edge.client, 5_200, { ip: "b", lastEventId: 1 })).toEqual({ status: "ok", replayed: 2 });
    });

    it("is off when the window is zero, and a fresh client never gets a replay", () => {
      const hub = createHub({ keepaliveMs: 60_000, stallMs: 10_000, maxClients: 10 });
      hub.broadcast("data: 1\n\n", 100);
      expect(hub.buffered()).toBe(0);
      const c = fakeClient();
      expect(hub.add(c.client, 200, { ip: "a", lastEventId: 0 })).toEqual({ status: "ok", replayed: null });
      expect(hub.add(fakeClient().client, 200, { ip: "b" })).toEqual({ status: "ok", replayed: null });
    });
  });
});
