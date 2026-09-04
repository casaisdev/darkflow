/**
 * A minimal WebSocket server for tests: RFC 6455 handshake, text frames in
 * both directions, close. Enough to stand in for a JSON-RPC provider, and
 * nothing more — no fragmentation, no ping/pong, no extensions. Built on
 * node:http so the ingest keeps its zero-dependency rule in tests too.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type WsConnection = {
  send(text: string): void;
  close(): void;
  readonly open: boolean;
};

export type WsServer = {
  url: string;
  connections(): WsConnection[];
  /** Closes every open connection abruptly, as a dropped network would. */
  dropAll(): void;
  stop(): Promise<void>;
};

export type WsHandlers = {
  onConnection?(conn: WsConnection): void;
  onMessage(conn: WsConnection, text: string): void;
};

function encodeText(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Parses complete frames from `buf`; returns the frames and the unread rest. */
function decodeFrames(buf: Buffer): { frames: { opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let offset = 0;
  while (buf.length - offset >= 2) {
    const first = buf[offset]!;
    const second = buf[offset + 1]!;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let len = second & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (buf.length < pos + 2) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length < pos + 8) break;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (buf.length < pos + 4) break;
      mask = buf.subarray(pos, pos + 4);
      pos += 4;
    }
    if (buf.length < pos + len) break;
    const payload = Buffer.from(buf.subarray(pos, pos + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
    frames.push({ opcode, payload });
    offset = pos + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

export async function startWsServer(handlers: WsHandlers): Promise<WsServer> {
  const http: Server = createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  const sockets = new Set<Socket>();
  const conns = new Map<Socket, WsConnection>();

  http.on("upgrade", (req, socket: Socket) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    let open = true;
    const conn: WsConnection = {
      send(text) {
        if (open) socket.write(encodeText(text));
      },
      close() {
        if (!open) return;
        open = false;
        socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
        socket.end();
      },
      get open() {
        return open;
      },
    };
    conns.set(socket, conn);
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const { frames, rest } = decodeFrames(pending);
      pending = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x1) handlers.onMessage(conn, frame.payload.toString("utf8"));
        else if (frame.opcode === 0x8) {
          open = false;
          socket.end();
        }
      }
    });
    socket.on("close", () => {
      open = false;
      sockets.delete(socket);
      conns.delete(socket);
    });
    socket.on("error", () => {});
    handlers.onConnection?.(conn);
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    connections: () => [...conns.values()],
    dropAll() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      conns.clear();
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
