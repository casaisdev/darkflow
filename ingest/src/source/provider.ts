/**
 * The provider-backed Source: subscriptions and one
 * receipts call per block, over the plain Ethereum JSON-RPC dialect that
 * PublicNode, dRPC and every geth/reth-derived endpoint speak. A header call
 * exists for gap filling only.
 *
 * A source can carry the pending feed, the heads, or both: the same
 * file serves as the single connection and as either half of a split.
 *
 * This is the only file that knows the method names. It performs no
 * validation: raw objects go up as they arrived, and `wire/frames.ts` decides.
 */
import type { Hex } from "../../../web/types/stream.ts";
import { createRpc, type Rpc, type RpcOptions } from "./rpc.ts";
import type { RawHead, RawReceipt, RawTx, Source, SourceHandlers } from "./types.ts";

export type ProviderOptions = {
  urls: string[];
  /** Which feeds this connection carries. Both by default. */
  pending?: boolean;
  heads?: boolean;
  now?: () => number;
  reconnectMinMs?: number;
  /** Test seam: builds the rpc client. */
  rpcFactory?: (options: RpcOptions) => Rpc;
};

export function createProviderSource(options: ProviderOptions): Source {
  const { urls, pending = true, heads = true, now = Date.now, reconnectMinMs, rpcFactory = createRpc } = options;
  let rpc: Rpc | null = null;

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  function client(): Rpc {
    if (!rpc) throw new Error("provider: not subscribed");
    return rpc;
  }

  return {
    describe() {
      const url = rpc?.url() ?? urls[0] ?? "";
      return { name: hostOf(url), url };
    },

    subscribe(handlers: SourceHandlers) {
      if (rpc) throw new Error("provider: already subscribed");
      let pendingKey = "";
      let headsKey = "";
      const created = rpcFactory({
        urls,
        onLink: handlers.onLink,
        ...(reconnectMinMs !== undefined ? { backoffMinMs: reconnectMinMs } : {}),
        onNotification(key, result) {
          if (key === pendingKey) handlers.onPending(result as RawTx, now());
          else if (key === headsKey) handlers.onHead(result as RawHead);
        },
      });
      rpc = created;
      if (pending) pendingKey = created.subscribe("eth_subscribe", ["newPendingTransactions", true]);
      if (heads) headsKey = created.subscribe("eth_subscribe", ["newHeads"]);
      return () => {
        created.close();
        if (rpc === created) rpc = null;
      };
    },

    async blockReceipts(blockHash: Hex): Promise<RawReceipt[]> {
      const result = await client().call("eth_getBlockReceipts", [blockHash]);
      if (!Array.isArray(result)) throw new Error("provider: receipts are not an array");
      return result as RawReceipt[];
    },

    async blockHeader(blockHash: Hex): Promise<RawHead> {
      const result = await client().call("eth_getBlockByHash", [blockHash, false]);
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error("provider: unknown block");
      }
      return result as RawHead;
    },
  };
}
