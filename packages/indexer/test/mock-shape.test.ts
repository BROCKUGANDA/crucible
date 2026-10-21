import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { keccak256, hexToBytes, toHex, encodeEventTopics } from "viem";
import { TRIALS_ABI } from "@crucible/smith";
import { bloomMayContain } from "../src/scribe.js";

/**
 * The wire shape the indexer's mock has to speak.
 *
 * The mock in `scribe.test.ts` answers `eth_getBlockByNumber` with a block
 * whose bloom depends on the block NUMBER it was asked for — which is the only
 * way to test a cursor that stops at a specific block. It could not do that
 * for a long time, because the method it was listening for was not the one
 * viem sends: `getBlock` goes out as `eth_getBlockByNumber` with
 * `params: ["0x5", false]`, not as `eth_getBlock` with an object.
 *
 * The consequence of getting it wrong is a test that passes for the wrong
 * reason: every block answered with block zero, so the bloom cross-check
 * looked at the same bloom over and over and proved nothing.
 *
 * This test pins the shape, so a change in it is a red run rather than a
 * silently weakened test suite.
 */
describe("the block read the indexer makes", () => {
  it("goes out as eth_getBlockByNumber with the block number as a hex string", async () => {
    const trialTopic = encodeEventTopics({ abi: TRIALS_ABI, eventName: "TrialCreated" })[0] as `0x${string}`;
    const digest = hexToBytes(keccak256(trialTopic));
    const bloom = new Uint8Array(256);
    for (let i = 0; i < 3; i++) {
      const bit = (((digest[i * 2] ?? 0) << 8) | (digest[i * 2 + 1] ?? 0)) & 0x7ff;
      bloom[255 - (bit >> 3)] |= 1 << (bit & 7);
    }

    const seen: { method: string; params: unknown[] }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const calls = (Array.isArray(parsed) ? parsed : [parsed]) as {
          id: number;
          method: string;
          params?: unknown[];
        }[];
        seen.push(...calls.map((c) => ({ method: c.method, params: c.params ?? [] })));
        const block = (n: number) => ({
          number: toHex(n),
          hash: `0x${"11".repeat(32)}`,
          parentHash: `0x${"22".repeat(32)}`,
          nonce: "0x0",
          sha3Uncles: `0x${"33".repeat(32)}`,
          logsBloom: toHex(bloom),
          transactionsRoot: `0x${"44".repeat(32)}`,
          stateRoot: `0x${"55".repeat(32)}`,
          receiptsRoot: `0x${"66".repeat(32)}`,
          miner: `0x${"00".repeat(20)}`,
          difficulty: "0x0",
          totalDifficulty: "0x0",
          extraData: "0x",
          gasLimit: "0x1c9c380",
          gasUsed: "0x0",
          timestamp: "0x67000000",
          transactions: [],
          uncles: [],
          baseFeePerGas: "0x0",
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            calls.map((c) => {
              const raw = c.params?.[0];
              const n = Number(typeof raw === "string" ? BigInt(raw) : 0n);
              return { jsonrpc: "2.0", id: c.id, result: block(n) };
            }),
          ),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const { createPublicClient, http } = await import("viem");
    const { foundry } = await import("viem/chains");
    const client = createPublicClient({
      chain: foundry,
      transport: http(`http://127.0.0.1:${port}`, { batch: { wait: 20, batchSize: 64 } }),
    });

    const blocks = await Promise.all([0n, 1n, 2n].map((n) => client.getBlock({ blockNumber: n })));

    const getBlockCalls = seen.filter((c) => c.method === "eth_getBlockByNumber");
    expect(getBlockCalls.length).toBe(3);
    // The block number arrives as a hex string, so the node can answer with
    // that block's own bloom.
    expect(getBlockCalls.map((c) => c.params[0])).toEqual(["0x0", "0x1", "0x2"]);
    // And the block that comes back is the one that was asked for.
    expect(blocks.map((b) => b.number)).toEqual([0n, 1n, 2n]);
    expect(blocks.every((b) => bloomMayContain(b.logsBloom, trialTopic))).toBe(true);

    server.close();
  });
});
