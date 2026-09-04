import { describe, expect, it } from "vitest";
import { ConfigError, loadCoreConfig } from "../src/config.ts";

const good = {
  UPSTREAM_WS_URL: "wss://ethereum-rpc.publicnode.com, wss://eth.drpc.org",
};

describe("config", () => {
  it("reads the upstream list in order and the tunables' defaults", () => {
    const c = loadCoreConfig(good);
    expect(c.upstreamUrls).toEqual(["wss://ethereum-rpc.publicnode.com", "wss://eth.drpc.org"]);
    expect(c.blocksUrls).toBeNull();
    expect(c.poolTtlMs).toBe(300_000);
    expect(c.receiptsAttempts).toBe(3);
    expect(c.maxClientsPerIp).toBe(8);
    expect(c.replayMs).toBe(60_000);
    expect(c.pendingStaleMs).toBe(30_000);
    expect(c.idleStopMs).toBe(60_000);
    expect(c.streamMaxMs).toBe(0);
    expect(loadCoreConfig({ ...good, BLOCKS_WS_URL: "wss://eth.drpc.org" }).blocksUrls).toEqual(["wss://eth.drpc.org"]);
  });

  it("names the missing variable and refuses to default a network", () => {
    expect(() => loadCoreConfig({ UPSTREAM_WS_URL: "" })).toThrow(/UPSTREAM_WS_URL/);
    expect(() => loadCoreConfig({})).toThrow(/UPSTREAM_WS_URL/);
  });

  it("refuses a non-ws upstream", () => {
    expect(() => loadCoreConfig({ UPSTREAM_WS_URL: "https://eth.example" })).toThrow(ConfigError);
    expect(() => loadCoreConfig({ ...good, BLOCKS_WS_URL: "https://x" })).toThrow(/BLOCKS_WS_URL/);
  });

  it("validates tunables as bounded integers", () => {
    expect(loadCoreConfig({ ...good, MAX_CLIENTS: "50" }).maxClients).toBe(50);
    expect(() => loadCoreConfig({ ...good, MAX_CLIENTS: "0" })).toThrow(/MAX_CLIENTS/);
    expect(() => loadCoreConfig({ ...good, BATCH_INTERVAL_MS: "fast" })).toThrow(/BATCH_INTERVAL_MS/);
  });
});
