/**
 * What a source is. Everything downstream of this file is
 * provider-agnostic; a provider is one file under `source/`.
 *
 * Raw shapes are deliberately loose: they are what arrived over the wire,
 * validated by `wire/frames.ts` and nowhere else. Trusting a provider's field
 * to be a string because its docs say so is how a silent feed starts.
 */
import type { Hex } from "../../../web/types/stream.ts";

export type Raw = Record<string, unknown>;
export type RawTx = Raw;
export type RawHead = Raw;
export type RawReceipt = Raw;

export type LinkState = "open" | "reconnecting" | "closed";

export type SourceHandlers = {
  /** A transaction announced as pending, with the time this process saw it. */
  onPending(tx: RawTx, observedAt: number): void;
  /** A new chain head, replacement heads included. */
  onHead(head: RawHead): void;
  onLink(state: LinkState, detail?: string): void;
};

export type Source = {
  describe(): { name: string; url: string };
  /** Starts the upstream subscriptions. Returns the function that stops them. */
  subscribe(handlers: SourceHandlers): () => void;
  /** Receipts for one block, by hash — never by number. */
  blockReceipts(blockHash: Hex): Promise<RawReceipt[]>;
  /** The header of one block, by hash. Only used to fill a gap. */
  blockHeader(blockHash: Hex): Promise<RawHead>;
};
