import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKeeperAccount } from "../src/main.js";

/**
 * The account rule, exercised through `resolveKeeperAccount` — the exact function
 * `main.ts`'s boot path calls, not a copy of its logic. If these pass, the branch the
 * demo depends on and the branch that protects a funded chain are the same code that
 * actually runs, which is the one thing the audit insisted on.
 */

// Anvil's published account #0 — the derived address of DEMO_RELAYER_KEY. Hardcoded
// rather than re-derived from the key, so a test that asserts the *fallback happened* is
// also asserting the *right key* was chosen.
const DEV_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const openServers: Server[] = [];

/**
 * A stand-in for a node, on a real loopback socket. It answers `eth_chainId` with the hex
 * it is handed, so the production `createPublicClient(...).getChainId()` path runs against
 * a live endpoint — the same check `main.ts` relies on, not a mocked verdict.
 */
async function startStub(chainIdHex: string): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let id = 1;
      try {
        id = (JSON.parse(body).id as number) ?? 1;
      } catch {
        /* respond with a default id; the payload shape is not under test */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: chainIdHex }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  openServers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(() => {
  for (const server of openServers.splice(0)) server.close();
});

describe("resolveKeeperAccount", () => {
  it("uses a configured PRIVATE_KEY even against a non-loopback RPC, without asking the node", async () => {
    // Any key will do; this branch must NOT touch the network. A hostname that cannot
    // resolve proves it never dialed: the decision returns before `getChainId` runs.
    const configured =
      "0x59c6995e998f97a5a196ffcc75523d44b15d2e8f3d7c1e0b8e1c3f1c2c3d4e5f" as const;
    const out = await resolveKeeperAccount({
      privateKey: configured,
      rpcUrl: "https://rpc.that-would-never-answer.invalid",
    });
    expect(out.mode).toBe("configured keeper key");
    expect(out.account.address.toLowerCase()).not.toBe(DEV_ADDRESS);
  });

  it("falls back to the dev relayer key ONLY on a loopback node that reports Anvil's chain id", async () => {
    const rpcUrl = await startStub("0x7a69"); // 31337
    const out = await resolveKeeperAccount({ privateKey: "", rpcUrl });
    expect(out.mode).toBe("dev relayer on local Anvil");
    expect(out.account.address.toLowerCase()).toBe(DEV_ADDRESS);
  });

  it("refuses a loopback node that is NOT Anvil, naming the chain id it saw", async () => {
    const rpcUrl = await startStub("0x1"); // mainnet chain id, on loopback
    await expect(resolveKeeperAccount({ privateKey: "", rpcUrl })).rejects.toThrow(
      /reports chainId 1, not the local Anvil demo's 31337/,
    );
  });

  it("refuses a loopback RPC that cannot be reached, rather than assuming the demo", async () => {
    // Port 1 on loopback is not our stub: the connection is refused, and an unreachable
    // chain cannot be proven local, so the keeper fails closed.
    await expect(
      resolveKeeperAccount({ privateKey: "", rpcUrl: "http://127.0.0.1:1" }),
    ).rejects.toThrow(/did not answer eth_chainId/);
  });

  it("refuses a non-loopback RPC with no key, and names the variable to set", async () => {
    // This is the deployed-VPS case the audit flagged: `compose.yaml` points the keeper at
    // the `anvil` service, which is a container hostname, not loopback. With no
    // KEEPER_PRIVATE_KEY it must throw instead of signing with the public dev key.
    const err = await resolveKeeperAccount({
      privateKey: "",
      rpcUrl: "http://anvil:8545",
    }).then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("is not a loopback address");
    expect(err!.message).toContain("Set PRIVATE_KEY (KEEPER_PRIVATE_KEY in compose)");
    expect(err!.message).toContain("anvil:8545");
  });
});
