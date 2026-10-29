import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isProvableLocal, plan } from "../../../scripts/deploy-network.mjs";

/**
 * The deploy entry point must ask the node, not the operator.
 *
 * `Deploy.s.sol` used to fall back to Anvil's published account #0 with
 * `vm.envOr("PRIVATE_KEY", DEFAULT_PK)`. Moving that decision into Solidity looked like the
 * fix and was not: measured 2026-10-29, `forge script --rpc-url <node>` evaluates the script
 * in a local EVM that reports chain id 31337 whatever node it is pointed at, so a
 * `block.chainid` check inside the script cannot fire against Sepolia or mainnet. The only
 * place the chain can be interrogated is over JSON-RPC, before `forge` is started — which is
 * what `scripts/deploy-network.mjs` does, and what these tests hold.
 *
 * A fake RPC answers `eth_chainId` with whatever value each case needs, so every refusal here
 * is a decision the script actually made, not a network accident. The same trick
 * `mainnet-preflight.test.ts` uses, for the same reason: a gate that needs a live third-party
 * node is a gate that does not run.
 */

const ANVIL_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OPERATOR_KEY = "0x59c6995e998f97a5a0044966f094533579aee81dd4dbbe82c73bec743c0b44a7";

let server;
let chainId = 31337;
let secretPath = "/v2/super-secret-key-do-not-log";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${chainId.toString(16)}` }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});

afterAll(() => new Promise((r) => server.close(r)));

const rpc = () => `http://127.0.0.1:${server.address().port}${secretPath}`;
const argv = (...a) => ["--env", ...a, "--dry-run"];

describe("refusals — the ones that protect a deployment", () => {
  it("refuses when no environment is named", async () => {
    await expect(plan({ SEPOLIA_RPC_URL: rpc() }, ["--dry-run"])).rejects.toThrow(/Nothing here is inferred/);
  });

  it("refuses an environment name that is not defined", async () => {
    await expect(plan({}, argv("staging"))).rejects.toThrow(/--env must be one of/);
  });

  it("refuses when the node reports a different chain than the environment claims", async () => {
    chainId = 31337;
    await expect(plan({ SEPOLIA_RPC_URL: rpc() }, argv("testnet"))).rejects.toThrow(
      /"testnet" is defined as chain id 11155111, but the node .* reports 31337/,
    );
  });

  it("refuses a non-local chain with no deployer key, instead of taking the published one", async () => {
    chainId = 11155111;
    await expect(plan({ SEPOLIA_RPC_URL: rpc() }, argv("testnet"))).rejects.toThrow(
      /the published Anvil key is not an option/,
    );
  });

  it("refuses the published Anvil key presented as an explicit choice on a foreign chain", async () => {
    chainId = 11155111;
    await expect(
      plan({ SEPOLIA_RPC_URL: rpc(), PRIVATE_KEY: ANVIL_DEV_KEY }, argv("testnet")),
    ).rejects.toThrow(/Anvil's published account #0 on a non-local chain/);
  });

  it("refuses when the node cannot be reached at all, rather than defaulting to local", async () => {
    // Nothing listens on 1: the honest outcome is a refusal naming the reachability problem,
    // never a silent fall through to "assume the demo chain".
    await expect(plan({ RPC_URL: "http://127.0.0.1:1" }, argv("local"))).rejects.toThrow(/unreachable/i);
  });

  it("requires BOTH the local chain id and a loopback host before the dev key is allowed", async () => {
    // The impersonation this closes is a node that reports 31337 from somewhere else. A chain
    // id on its own proves nothing, which is why the keeper's rule and this one both check the
    // host, and why `anvil` — reachable from other containers on the compose network — is out.
    expect(isProvableLocal("http://127.0.0.1:8545", 31337n)).toBe(true);
    expect(isProvableLocal("http://localhost:8545", 31337n)).toBe(true);
    expect(isProvableLocal("http://[::1]:8545", 31337n)).toBe(true);
    expect(isProvableLocal("http://anvil:8545", 31337n)).toBe(false);
    expect(isProvableLocal("http://198.51.100.7:8545", 31337n)).toBe(false);
    expect(isProvableLocal("http://eth.drpc.org", 31337n)).toBe(false);
    expect(isProvableLocal("http://127.0.0.1:8545", 11155111n)).toBe(false);
  });

  it("refuses when the environment's RPC variable is empty", async () => {
    await expect(plan({ SEPOLIA_RPC_URL: "  " }, argv("testnet"))).rejects.toThrow(/SEPOLIA_RPC_URL is not set/);
  });

  it("requires the mainnet preflight before production is even a plan", async () => {
    chainId = 1;
    const p = await plan({ MAINNET_RPC_URL: rpc(), PRIVATE_KEY: OPERATOR_KEY }, argv("production"));
    expect(p.requiresPreflight).toBe(true);
  });
});

describe("the plans that are allowed, and what they say", () => {
  it("accepts a real deployer key on the chain it matches", async () => {
    chainId = 11155111;
    const p = await plan({ SEPOLIA_RPC_URL: rpc(), PRIVATE_KEY: OPERATOR_KEY }, argv("testnet"));
    expect(p).toMatchObject({ envName: "testnet", chainId: 11155111, usesDevKey: false, dryRun: true });
  });

  it("accepts the dev key only when the chain is loopback AND local", async () => {
    chainId = 31337;
    const p = await plan({ RPC_URL: rpc() }, argv("local"));
    expect(p.usesDevKey).toBe(true);
  });

  it("prints a host, never the URL, because an Alchemy endpoint carries its key in the path", async () => {
    chainId = 11155111;
    const p = await plan({ SEPOLIA_RPC_URL: rpc(), PRIVATE_KEY: OPERATOR_KEY }, argv("testnet"));
    expect(p.rpcHost).toBe("127.0.0.1");
    expect(JSON.stringify({ rpcHost: p.rpcHost, env: p.envName, chainId: p.chainId })).not.toContain(
      secretPath.split("/").pop(),
    );
    // The URL is still carried for the RPC call itself — the point is that the loggable field
    // is separate from it, so the line the operator pastes into a ticket is safe.
    expect(p.rpcUrl).toContain(secretPath.split("/").pop());
  });

  it("names the chain id each environment expects when it disagrees, including production", async () => {
    chainId = 11155111;
    await expect(
      plan({ MAINNET_RPC_URL: rpc(), PRIVATE_KEY: OPERATOR_KEY }, argv("production")),
    ).rejects.toThrow(/"production" is defined as chain id 1, but the node .* reports 11155111/);
  });
});
