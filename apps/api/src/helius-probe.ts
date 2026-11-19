import { resolveHeliusConfig } from "./helius.js";
import { createRequire } from "node:module";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MAX_BYTES = 16_384;
type Socket = Pick<WebSocket, "addEventListener" | "removeEventListener" | "send" | "close"> & {
  terminate: () => void;
};
// Reuse the installed server-side ws runtime; never follow credential-bearing redirects.
const Ws = createRequire(import.meta.url)("ws") as new (url: string, options: {
  handshakeTimeout: number; maxPayload: number; followRedirects: boolean;
}) => Socket & { on: (event: string, listener: () => void) => void };
function connect(url: string): Socket {
  const socket = new Ws(url, { handshakeTimeout: 10_000, maxPayload: MAX_BYTES, followRedirects: false });
  socket.on("error", () => {});
  return socket;
}
export type HeliusTransports = {
  fetch: typeof fetch;
  connect: (url: string) => Socket;
};
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function envelope(value: unknown, id: number): unknown {
  if (!record(value) || value.jsonrpc !== "2.0" || value.id !== id ||
      "error" in value || !("result" in value)) throw new Error("invalid_response");
  return value.result;
}

/** Fixed read-only methods only. Never return provider messages, URLs or thrown errors. */
export async function probeHelius(
  env: Readonly<Record<string, string | undefined>>,
  transports: HeliusTransports = { fetch: globalThis.fetch, connect },
  timeoutMs = 10_000,
): Promise<{ ok: true; network: "solana-mainnet"; slot: number; notificationSlot: number } |
  { ok: false; reason: string }> {
  const config = resolveHeliusConfig(env);
  if (!config.configured) return { ok: false, reason: config.reason };
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    return { ok: false, reason: "invalid_timeout" };
  }
  const controller = new AbortController();
  let socket: Socket | undefined;
  let subscription: number | undefined;
  let unsubscribeSent = false;
  let dispose = () => {};
  let phase = "rpc_failed";
  let timer: ReturnType<typeof setTimeout>;
  const unsubscribe = () => {
    if (socket && subscription !== undefined && !unsubscribeSent) {
      unsubscribeSent = true;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "slotUnsubscribe", params: [subscription] }));
    }
  };
  const work = async () => {
    const rpc = async (method: "getGenesisHash" | "getSlot", id: number) => {
      const response = await transports.fetch(config.rpcUrl, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: [] }),
      });
      controller.signal.throwIfAborted();
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("rpc_failed");
      }
      const reader = response.body.getReader();
      let text = "";
      let bytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_BYTES) throw new Error("invalid_response");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return envelope(JSON.parse(text), id);
    };
    const genesis = await rpc("getGenesisHash", 1);
    if (genesis !== MAINNET_GENESIS) { phase = "mainnet_mismatch"; throw new Error(); }
    const slot = await rpc("getSlot", 2);
    controller.signal.throwIfAborted();
    if (!integer(slot)) throw new Error();
    phase = "ws_failed";
    const notificationSlot = await new Promise<number>((resolve, reject) => {
      socket = transports.connect(config.wsUrl);
      let observed: number | undefined;
      let subscribed = false;
      const fail = () => reject(new Error());
      const open = () => {
        try {
          if (subscribed) throw new Error();
          subscribed = true;
          socket!.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "slotSubscribe", params: [] }));
        } catch { fail(); }
      };
      const message = (event: Event) => {
        try {
          const data: unknown = (event as MessageEvent).data;
          if (typeof data !== "string" || Buffer.byteLength(data) > MAX_BYTES) throw new Error();
          const value: unknown = JSON.parse(data);
          if (!subscribed || !record(value)) throw new Error();
          if (subscription === undefined) {
            const result = envelope(value, 3);
            if (!integer(result)) throw new Error();
            subscription = result;
          } else if (value.method === "slotNotification") {
            const params = value.params;
            if (value.jsonrpc !== "2.0" || "error" in value || "id" in value || !record(params) || params.subscription !== subscription ||
                !record(params.result) || !integer(params.result.slot) ||
                !integer(params.result.parent) || !integer(params.result.root) ||
                params.result.parent >= params.result.slot || params.result.root > params.result.parent) throw new Error();
            if (observed === undefined) {
              observed = params.result.slot;
              unsubscribe();
            }
          } else {
            if (observed === undefined || envelope(value, 4) !== true) throw new Error();
            resolve(observed);
          }
        } catch { fail(); }
      };
      socket.addEventListener("open", open);
      socket.addEventListener("message", message);
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
      dispose = () => {
        socket!.removeEventListener("open", open);
        socket!.removeEventListener("message", message);
        socket!.removeEventListener("error", fail);
        socket!.removeEventListener("close", fail);
      };
    });
    return { ok: true as const, network: "solana-mainnet" as const, slot, notificationSlot };
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { phase = "timeout"; controller.abort(); reject(new Error()); }, timeoutMs);
    })]);
  } catch {
    return { ok: false, reason: phase };
  } finally {
    clearTimeout(timer!);
    controller.abort();
    try { unsubscribe(); } catch { /* Best effort; close also releases the subscription. */ }
    dispose();
    try { socket?.close(); } catch { /* No provider details escape cleanup. */ }
    try { socket?.terminate(); } catch { /* Bound cleanup even without a close handshake. */ }
  }
}