import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockEvent, blockFrame, pendingTx, serialize, txsFrame } from "../../ingest/src/wire/frames.ts";
import { createSseSource } from "@/lib/stream/sse";
import { WIRE_VERSION, type BlockEvent, type PendingTx } from "@/types/stream";

/**
 * The two ends of the wire, against each other.
 *
 * The ingest builds frames with its validator (`ingest/src/wire/frames.ts`)
 * and the page accepts them with its own (`lib/stream/sse.ts`). Each is
 * tested against its author's idea of the contract; this is the test that
 * puts a frame the ingest actually serialises through the parser the page
 * actually runs. What goes in is the recorded provider fixtures — real
 * shapes — and what must come out is the same transaction, the same block,
 * field for field.
 */
const fixtures = new URL("../../ingest/fixtures/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
const rawPending: Record<string, unknown>[] = read("pending.json");
const { head, receipts } = read("receipts.json") as { head: Record<string, unknown>; receipts: Record<string, unknown>[] };

/** The browser's `EventSource`, reduced to what the page uses. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {}
  /** Hands the page exactly the `data:` payload of one serialised frame. */
  receive(sseText: string) {
    const data = sseText
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    this.onmessage?.({ data } as MessageEvent<string>);
  }
}

function page() {
  const batches: { txs: readonly PendingTx[]; snapshot: boolean }[] = [];
  const blocks: BlockEvent[] = [];
  createSseSource("https://site.example/api/stream")(
    (txs, meta) => batches.push({ txs, snapshot: meta.snapshot }),
    (block) => blocks.push(block),
    {},
  );
  return { batches, blocks, source: FakeEventSource.instances.at(-1)! };
}

const NOW = 1_800_000_000_000;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("what the ingest serialises, the page parses", () => {
  it("every recorded pending transaction survives the wire, field for field", () => {
    const sent = rawPending.map((raw) => pendingTx(raw, NOW, NOW)).flatMap((p) => (p.ok ? [p.value] : []));
    expect(sent).toHaveLength(rawPending.length);
    const { batches, source } = page();
    source.receive(serialize(txsFrame(sent)));
    expect(batches).toHaveLength(1);
    expect(batches[0]!.snapshot).toBe(false);
    // The page filters a batch entry by entry; every one must have made it.
    expect(batches[0]!.txs).toHaveLength(sent.length);
    expect(batches[0]!.txs).toEqual(sent);
  });

  it("a recorded block survives the wire with its gas and its tips", () => {
    const built = blockEvent(head, receipts);
    if (!built.ok) throw new Error(built.reason);
    const { blocks, source } = page();
    source.receive(serialize(blockFrame(built.value)));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual(built.value);
    expect(blocks[0]!.tips).toHaveLength(receipts.length);
  });

  it("a block the ingest sends without tips is still a block to the page", () => {
    const partial = receipts.map((r, i) => (i === 0 ? { ...r, effectiveGasPrice: undefined } : r));
    const built = blockEvent(head, partial);
    if (!built.ok) throw new Error(built.reason);
    expect("tips" in built.value).toBe(false);
    const { blocks, source } = page();
    source.receive(serialize(blockFrame(built.value)));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.tips).toBeUndefined();
  });

  it("the versions agree, and a frame from another version is dropped whole", () => {
    const built = blockEvent(head, receipts);
    if (!built.ok) throw new Error(built.reason);
    const frame = blockFrame(built.value);
    expect(frame.v).toBe(WIRE_VERSION);
    const { blocks, source } = page();
    source.receive(`data: ${JSON.stringify({ ...frame, v: WIRE_VERSION + 1 })}\n\n`);
    expect(blocks).toHaveLength(0);
  });
});
