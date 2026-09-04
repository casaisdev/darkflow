import { afterEach, describe, expect, it } from "vitest";
import { createIngestCore, type IngestCore } from "../src/core.ts";
import { createLogger } from "../src/log.ts";
import type { Client } from "../src/hub.ts";
import { startFakeProvider, testConfig, waitFor, type FakeProvider } from "./helpers/fake-provider.ts";

function client(): Client & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    write(chunk) {
      written.push(chunk);
      return true;
    },
    end() {},
    onDrain() {},
  };
}

/**
 * The on-demand lifecycle: nothing upstream until the
 * first client, nothing upstream once the last one has been gone long enough.
 */
describe("the core runs on demand", () => {
  let provider: FakeProvider;
  let core: IngestCore;
  afterEach(async () => {
    core?.stop();
    await provider?.stop();
  });

  it("subscribes on the first client, drops the upstream after the idle window, and comes back for the next", async () => {
    provider = await startFakeProvider();
    let skew = 0;
    core = createIngestCore(testConfig(provider.url, { idleStopMs: 5_000 }), { log: createLogger(() => {}), now: () => Date.now() + skew });
    // Created idle: no connection, no subscription.
    await new Promise((r) => setTimeout(r, 100));
    expect(core.running()).toBe(false);
    expect(provider.subscribeCalls).toEqual([]);
    expect((core.state() as { links: { pending: { state: string } } }).links.pending.state).toBe("closed");

    const a = client();
    expect(core.addClient(a, Date.now(), { ip: "a" })).toEqual({ status: "ok", replayed: null });
    expect(core.running()).toBe(true);
    await waitFor(() => provider.subscribeCalls.length === 2);
    expect(provider.openConnections()).toBe(1);

    // The client leaves. Within the window the upstream stays; past it, it goes.
    core.removeClient(a);
    skew = 4_000;
    await new Promise((r) => setTimeout(r, 1_100)); // one tick
    expect(core.running()).toBe(true);
    skew = 6_000;
    await waitFor(() => !core.running(), 3_000);
    await waitFor(() => provider.openConnections() === 0, 3_000);
    expect((core.state() as { idleStops: number }).idleStops).toBe(1);

    // The next visitor starts it again, and the subscriptions are fresh ones.
    const b = client();
    expect(core.addClient(b, Date.now() + skew, { ip: "b" }).status).toBe("ok");
    expect(core.running()).toBe(true);
    await waitFor(() => provider.subscribeCalls.length === 4);
    expect((core.state() as { starts: number }).starts).toBe(2);
  }, 15_000);

  it("stays on when idleStopMs is 0, from creation", async () => {
    provider = await startFakeProvider();
    core = createIngestCore(testConfig(provider.url, { idleStopMs: 0 }), { log: createLogger(() => {}) });
    expect(core.running()).toBe(true);
    await waitFor(() => provider.subscribeCalls.length === 2);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(core.running()).toBe(true);
  });

  it("does not start the upstream for a client it refuses", async () => {
    provider = await startFakeProvider();
    core = createIngestCore(testConfig(provider.url, { idleStopMs: 5_000, maxClientsPerIp: 1 }), { log: createLogger(() => {}) });
    const a = client();
    core.addClient(a, Date.now(), { ip: "a" });
    core.stop();
    expect(core.running()).toBe(false);
    expect(core.addClient(client(), Date.now(), { ip: "a" })).toEqual({ status: "ip-limit" });
    expect(core.running()).toBe(false);
  });
});
