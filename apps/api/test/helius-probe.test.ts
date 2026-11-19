import { afterEach, describe, expect, it, vi } from "vitest";
import { probeHelius } from "../src/helius-probe.js";
import { runHeliusCli } from "../src/helius-cli.js";
import { createRequire } from "node:module";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import type { HeliusTransports } from "../src/helius-probe.js";

const env = { HELIUS_API_KEY: "offline-secret" };
const genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const reply = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result });
const notification = { jsonrpc: "2.0", method: "slotNotification", params: {
  subscription: 9, result: { slot: 101, parent: 100, root: 99 },
} };
class TestSocket extends EventTarget {
  sent: Record<string, unknown>[] = [];
  close = vi.fn();
  terminate = vi.fn();
  onSend: (request: Record<string, unknown>) => void = () => {};
  send(data: string) {
    const request = JSON.parse(data);
    this.sent.push(request);
    queueMicrotask(() => this.onSend(request));
  }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}
function fixture(options: { genesis?: unknown; slot?: unknown; mode?: string; ack?: unknown } = {}) {
  const socket = new TestSocket();
  socket.onSend = (request) => {
    if (request.method === "slotSubscribe") {
      if (options.mode === "error") { socket.dispatchEvent(new Event("error")); return; }
      if (options.mode === "close") { socket.dispatchEvent(new Event("close")); return; }
      if (options.mode === "no_ack") return;
      socket.message(reply(3, 9));
      if (options.mode === "no_notification") return;
      socket.message(options.mode === "bad_notification" ? { ...notification, params: { ...notification.params, subscription: 8 } } : notification);
    } else if (options.mode !== "no_unsubscribe_ack") {
      socket.message(reply(4, options.ack ?? true));
    }
  };
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    return Response.json(reply(request.id, request.method === "getGenesisHash" ?
      (options.genesis ?? genesis) : (options.slot ?? 100)));
  });
  const connect = vi.fn(() => {
    queueMicrotask(() => socket.dispatchEvent(new Event("open")));
    return socket;
  });
  return { socket, fetcher, connect, transports: { fetch: fetcher, connect } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded read-only Helius probe", () => {
  it("validates mainnet, reads a slot and observes a matching notification before unsubscribing", async () => {
    const f = fixture();
    expect(await probeHelius(env, f.transports)).toEqual({ ok: true, network: "solana-mainnet", slot: 100, notificationSlot: 101 });
    expect(f.fetcher.mock.calls.map(([url, init]) => ({ url, ...JSON.parse(init!.body as string) }))).toEqual([
      { url: "https://mainnet.helius-rpc.com/?api-key=offline-secret", jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] },
      { url: "https://mainnet.helius-rpc.com/?api-key=offline-secret", jsonrpc: "2.0", id: 2, method: "getSlot", params: [] },
    ]);
    expect(f.fetcher.mock.calls.every(([, init]) => init!.redirect === "error" && init!.method === "POST")).toBe(true);
    expect(f.connect).toHaveBeenCalledExactlyOnceWith("wss://mainnet.helius-rpc.com/?api-key=offline-secret");
    expect(f.socket.sent).toEqual([
      { jsonrpc: "2.0", id: 3, method: "slotSubscribe", params: [] },
      { jsonrpc: "2.0", id: 4, method: "slotUnsubscribe", params: [9] },
    ]);
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(f.socket.terminate).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0][1]!.signal!.aborted).toBe(true);
  });

  it.each([{}, { ...env, HELIUS_WS_URL: "" }])("rejects configuration before opening transports", async (config) => {
    const f = fixture();
    expect((await probeHelius(config, f.transports)).ok).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each([0, 10001, NaN, 1.5])("rejects invalid timeout %s", async (timeout) => {
    const f = fixture();
    expect(await probeHelius(env, f.transports, timeout)).toEqual({ ok: false, reason: "invalid_timeout" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["devnet", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"])("stops before slot and WSS on a non-mainnet genesis: %s", async (value) => {
    const f = fixture({ genesis: value });
    expect(await probeHelius(env, f.transports)).toEqual({ ok: false, reason: "mainnet_mismatch" });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, "100", Number.MAX_SAFE_INTEGER + 1])("rejects invalid RPC slot %j", async (slot) => {
    const f = fixture({ slot });
    expect(await probeHelius(env, f.transports)).toEqual({ ok: false, reason: "rpc_failed" });
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each([
    { jsonrpc: "2.0", id: 2, result: genesis },
    { jsonrpc: "1.0", id: 1, result: genesis },
    { jsonrpc: "2.0", id: 1, result: genesis, error: { message: "offline-secret" } },
    [], null,
  ])("rejects invalid RPC envelopes without exposing them", async (value) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(Response.json(value));
    expect(await probeHelius(env, f.transports)).toEqual({ ok: false, reason: "rpc_failed" });
    expect(f.connect).not.toHaveBeenCalled();
  });

  it.each(["error", "close", "bad_notification"])("cleans up after WSS %s", async (mode) => {
    const f = fixture({ mode });
    expect(await probeHelius(env, f.transports)).toEqual({ ok: false, reason: "ws_failed" });
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(f.socket.terminate).toHaveBeenCalledOnce();
    if (mode === "bad_notification") expect(f.socket.sent[1]).toEqual({ jsonrpc: "2.0", id: 4, method: "slotUnsubscribe", params: [9] });
    const count = f.socket.sent.length;
    f.socket.dispatchEvent(new Event("open"));
    expect(f.socket.sent).toHaveLength(count);
  });

  it.each(["no_ack", "no_notification", "no_unsubscribe_ack"])("bounds %s and releases socket, listeners and timers", async (mode) => {
    vi.useFakeTimers();
    const f = fixture({ mode });
    const result = probeHelius(env, f.transports, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ ok: false, reason: "timeout" });
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(f.socket.terminate).toHaveBeenCalledOnce();
    expect(f.socket.sent.filter((r) => r.method === "slotUnsubscribe")).toHaveLength(mode === "no_ack" ? 0 : 1);
    const count = f.socket.sent.length;
    f.socket.dispatchEvent(new Event("open"));
    f.socket.message(reply(3, 10));
    expect(f.socket.sent).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a hung HTTP read without starting WSS", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let signal: AbortSignal | undefined;
    f.fetcher.mockImplementation((_url, init) => {
      signal = init!.signal!;
      return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("offline-secret"))));
    });
    const result = probeHelius(env, f.transports, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ ok: false, reason: "timeout" });
    expect(signal!.aborted).toBe(true);
    expect(f.connect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, "true", 1])("requires a true unsubscribe acknowledgement (%j)", async (ack) => {
    const f = fixture({ ack });
    expect(await probeHelius(env, f.transports)).toEqual({ ok: false, reason: "ws_failed" });
    expect(f.socket.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    reply(88, 9), reply(3, -1), { jsonrpc: "2.0", id: 3, error: "offline-secret" },
    { ...notification, jsonrpc: "1.0" },
    { ...notification, params: { subscription: 9, result: { slot: "101", parent: 100, root: 99 } } },
    { ...notification, params: { subscription: 9, result: { slot: 101, parent: 101, root: 99 } } },
    { ...notification, params: { subscription: 9, result: { slot: 101, parent: 100, root: 102 } } },
    { ...notification, error: "offline-secret" },
  ])("rejects malformed WSS data %j", async (value) => {
    const f = fixture();
    f.socket.onSend = (request) => {
      if (request.method !== "slotSubscribe") return;
      if (!Object.hasOwn(value, "id") || value.id !== 3) f.socket.message(reply(3, 9));
      f.socket.message(value);
    };
    expect(await probeHelius(env, f.transports)).toEqual({ ok: false, reason: "ws_failed" });
    expect(f.socket.terminate).toHaveBeenCalledOnce();
  });

  it.each(["binary", "oversize", "json", "send"])("cleans up WSS %s failures", async (mode) => {
    const f = fixture();
    if (mode === "send") f.socket.send = () => { throw new Error("offline-secret"); };
    else f.socket.onSend = () => f.socket.dispatchEvent(new MessageEvent("message", {
      data: mode === "binary" ? new Uint8Array([1]) : mode === "oversize" ? "x".repeat(16385) : "offline-secret",
    }));
    expect(await probeHelius(env, f.transports)).toEqual({ ok: false, reason: "ws_failed" });
    expect(f.socket.terminate).toHaveBeenCalledOnce();
  });

  it.each(["throw", "http", "oversize", "json"])("redacts provider failure %s", async (mode) => {
    const f = fixture();
    f.fetcher.mockImplementation(async () => {
      if (mode === "throw") throw new Error("https://mainnet.helius-rpc.com/?api-key=offline-secret");
      if (mode === "http") return new Response("offline-secret", { status: 401 });
      return new Response(mode === "oversize" ? "x".repeat(16385) : "offline-secret");
    });
    expect(await probeHelius(env, f.transports)).toEqual({ ok: false, reason: "rpc_failed" });
    expect(f.connect).not.toHaveBeenCalled();
  });
});

describe("operator CLI", () => {
  it("reports success only from the actual offline probe state machine", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const f = fixture();
    expect(await runHeliusCli(["--live"], env, (config) => probeHelius(config, f.transports))).toBe(0);
    expect(log).toHaveBeenCalledWith('{"ok":true,"network":"solana-mainnet","slot":100,"notificationSlot":101}');
  });
  it.each([[], ["--help"], ["--live", "--url=evil"]])("refuses without exactly the opt-in flag %j", async (...args) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const probe = vi.fn();
    expect(await runHeliusCli(args.flat(), env, probe)).toBe(2);
    expect(probe).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('{"ok":false,"reason":"explicit_live_flag_required"}');
  });
  it("maps offline transport failure to a nonzero exit", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const f = fixture({ genesis: "devnet" });
    expect(await runHeliusCli(["--live"], env, (config) => probeHelius(config, f.transports))).toBe(1);
  });
});

describe("real installed ws transport against loopback only", () => {
  it.each([false, true])("releases the actual server connection (timeout=%s)", async (timeout) => {
    type RealSocket = ReturnType<HeliusTransports["connect"]> & EventEmitter & { readyState: number };
    const ws = createRequire(import.meta.url)("ws") as {
      WebSocket: new (url: string) => RealSocket;
      WebSocketServer: new (options: { host: string; port: number }) => EventEmitter & {
        address: () => AddressInfo;
        clients: Set<RealSocket>;
        close: (callback: (error?: Error) => void) => void;
      };
    };
    const server = new ws.WebSocketServer({ host: "127.0.0.1", port: 0 });
    const methods: string[] = [];
    let client: RealSocket | undefined;
    let disconnected: Promise<unknown> | undefined;
    // The client's own close event, captured when it is created.
    //
    // `readyState` moves CLOSING(2) -> CLOSED(3) asynchronously, and the server's
    // close event says nothing about the client having finished moving: asserting
    // 3 right after the server noticed races the client and failed in CI (green
    // locally, red on the runner). Waiting on the client's event is waiting on
    // the quantity the assertion is about.
    let clientClosed: Promise<unknown> | undefined;
    server.on("connection", (peer: RealSocket) => {
      disconnected = once(peer, "close");
      peer.on("message", (data: Buffer) => {
        const request = JSON.parse(data.toString());
        methods.push(request.method);
        if (request.method === "slotSubscribe") {
          peer.send(JSON.stringify(reply(3, 9)));
          if (!timeout) peer.send(JSON.stringify(notification));
        } else peer.send(JSON.stringify(reply(4, true)));
      });
    });
    await once(server, "listening");
    try {
      const f = fixture();
      const result = await probeHelius(env, {
        fetch: f.fetcher,
        connect: () => {
          client = new ws.WebSocket(`ws://127.0.0.1:${server.address().port}`);
          client.on("error", () => {});
          clientClosed = once(client, "close");
          return client;
        },
      }, timeout ? 500 : 2000);
      expect(result.ok).toBe(!timeout);
      if (timeout) expect(result).toEqual({ ok: false, reason: "timeout" });
      await disconnected;
      await clientClosed;
      expect(server.clients.size).toBe(0);
      expect(client!.readyState).toBe(3);
      expect(methods.filter((m) => m === "slotSubscribe")).toHaveLength(1);
      if (!timeout) expect(methods).toEqual(["slotSubscribe", "slotUnsubscribe"]);
    } finally {
      client?.terminate();
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});