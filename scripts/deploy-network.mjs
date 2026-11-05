#!/usr/bin/env node
// Deploy Crucible's contracts to a NAMED environment, after asking the node what chain it
// is — never after being told.
//
// Why this exists as a wrapper rather than as a check inside `Deploy.s.sol`, measured
// 2026-10-29 with forge 1.8.5: `forge script --rpc-url <node>` evaluates the script in a
// local EVM whose `block.chainid` reports 31337 regardless of which node it is pointed at.
// A chain-id guard written in Solidity therefore cannot fire against Sepolia or mainnet.
// The node can only be interrogated from outside, over JSON-RPC, which is what this does.
//
// The rules it enforces, in the order they can fail:
//   1. `--env` is required. Nothing is inferred from a missing variable — an unset
//      `CRUCIBLE_ENV` does not become "local", and a missing RPC URL does not become
//      mainnet. (The rule `scripts/mainnet-preflight.mjs` already holds for launch.)
//   2. The RPC must answer `eth_chainId` with the id that environment is defined to have.
//   3. A deployer key must be present, non-empty, and NOT Anvil's published account #0
//      unless the chain is provably the local demo node.
//   4. Production additionally requires the mainnet preflight to pass.
//   5. Only then is `forge script` invoked, and the deployed addresses are re-read to
//      confirm each one actually has code.
//
// `--dry-run` stops after step 4 and prints the plan: it exists so the refusals are
// testable without a network, a key, or spending anything.

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Anvil's documented account #0. Public knowledge — which is exactly why it needs a gate. */
const ANVIL_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** What each environment means. Add one by naming its chain id and where its RPC comes from. */
const ENVS = {
  local: { chainId: 31337, rpcVar: "RPC_URL", defaultRpc: "http://127.0.0.1:8545", allowDevKey: true },
  testnet: { chainId: 11155111, rpcVar: "SEPOLIA_RPC_URL", allowDevKey: false },
  production: { chainId: 1, rpcVar: "MAINNET_RPC_URL", allowDevKey: false, requiresPreflight: true },
};

class Refusal extends Error {}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function host(url) {
  try {
    // WHATWG gives IPv6 hosts back bracketed (`[::1]`), and a bracket never matches a
    // loopback entry — found by the table in packages/eval/test/deploy-network.test.ts.
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

/**
 * Is this endpoint provably the local demo chain?
 *
 * Both halves are required: the id must be Anvil's, and the host must be loopback. A
 * service name like `anvil` is deliberately not accepted — inside the compose network it is
 * reachable from other containers, which is the same reasoning `apps/keeper/src/main.ts`
 * uses for the identical rule, and the reason a chain id alone is not proof of anything.
 */
export function isProvableLocal(rpcUrl, observedChainId) {
  return Number(observedChainId) === 31337 && LOOPBACK.has(host(rpcUrl));
}

/** Read the chain id from the node. A timeout is a refusal, not a retry-then-hope. */
async function nodeChainId(rpcUrl, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Refusal(`RPC answered HTTP ${res.status}`);
    const json = await res.json();
    if (typeof json.result !== "string") throw new Refusal(`RPC returned no chain id: ${JSON.stringify(json.error ?? json)}`);
    return BigInt(json.result);
  } catch (err) {
    if (err instanceof Refusal) throw err;
    throw new Refusal(`RPC unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** `eth_getCode` must return real bytes for an address we believe we just deployed. */
async function hasCode(rpcUrl, address) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
  });
  const json = await res.json();
  return typeof json.result === "string" && json.result.length > 2;
}

export async function plan(env = process.env, argv = process.argv.slice(2)) {
  const envName = argv[argv.indexOf("--env") + 1];
  if (!envName || !ENVS[envName]) {
    throw new Refusal(`--env must be one of ${Object.keys(ENVS).join(", ")} (got "${envName ?? ""}"). Nothing here is inferred from a missing variable.`);
  }
  const spec = ENVS[envName];
  const rpcUrl = (env[spec.rpcVar] ?? spec.defaultRpc ?? "").trim();
  if (!rpcUrl) throw new Refusal(`${spec.rpcVar} is not set. Refusing to guess an endpoint for "${envName}".`);

  const observed = await nodeChainId(rpcUrl);
  if (observed !== BigInt(spec.chainId)) {
    throw new Refusal(
      `"${envName}" is defined as chain id ${spec.chainId}, but the node at ${spec.rpcVar} reports ${observed}. ` +
        `Refusing to deploy.`,
    );
  }

  // The deployer has its own variable, and it is checked BEFORE `PRIVATE_KEY`: that name is what
  // the keeper relayer inherits inside its container (`compose.yaml` maps KEEPER_PRIVATE_KEY ->
  // PRIVATE_KEY), so a key that is correct for one role is silently wrong for the other. Neither
  // value is ever put into the plan — `signerSource` names the variable, not its contents.
  const signerSource = (env.DEPLOYER_PRIVATE_KEY ?? "").trim() ? "DEPLOYER_PRIVATE_KEY" : "PRIVATE_KEY";
  const pk = (env[signerSource] ?? "").trim();
  const isLocalNode = isProvableLocal(rpcUrl, observed);
  if (!pk) {
    if (!spec.allowDevKey) throw new Refusal(`PRIVATE_KEY is not set. "${envName}" is not a local demo chain, so the published Anvil key is not an option.`);
    if (!isLocalNode) throw new Refusal(`PRIVATE_KEY is not set and the RPC host is not loopback, so this is not a provable local demo.`);
  } else if (pk.toLowerCase().replace(/^0x/, "") === ANVIL_DEV_KEY.slice(2).toLowerCase() && !isLocalNode) {
    throw new Refusal(`PRIVATE_KEY is Anvil's published account #0 on a non-local chain. Anyone can sign for that key; do not deploy with it here.`);
  }

  return {
    envName,
    chainId: spec.chainId,
    rpcVar: spec.rpcVar,
    // The host only: an Alchemy/Infura URL carries its credential in the path. Never echo it.
    rpcHost: host(rpcUrl),
    rpcUrl,
    usesDevKey: !pk,
    /** which variable the key came from — the name only, never the value */
    signerSource: pk ? signerSource : null,
    requiresPreflight: Boolean(spec.requiresPreflight),
    dryRun: argv.includes("--dry-run"),
  };
}

function forgeScript(p) {
  return [
    "script",
    "script/Deploy.s.sol:Deploy",
    "--rpc-url",
    p.rpcUrl,
    "--broadcast",
    ...(p.signerSource ? ["--private-key", String(process.env[p.signerSource]).trim()] : []),
  ];
}

async function main() {
  let p;
  try {
    p = await plan(process.env, process.argv.slice(2));
  } catch (err) {
    console.error(`REFUSED: ${err.message}`);
    return 2;
  }

  if (p.requiresPreflight) {
    console.error("production deploy requires `npm run mainnet:preflight` to pass first; running it now.");
    const ok = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, "scripts", "mainnet-preflight.mjs")], { stdio: "inherit" });
      child.on("close", (code) => resolve(code === 0));
    });
    if (!ok) {
      console.error("REFUSED: the mainnet preflight did not pass.");
      return 2;
    }
  }

  console.log(
    `plan: env=${p.envName} chainId=${p.chainId} rpc=${p.rpcVar}@${p.rpcHost} ` +
      `signer=${p.signerSource ?? "anvil-dev-key(loopback-verified)"} broadcast=${p.dryRun ? "no (dry run)" : "yes"}`,
  );
  if (p.dryRun) return 0;

  const { resolveFoundry } = await import(join(ROOT, "scripts", "lib", "foundry.mjs"));
  const forge = resolveFoundry("forge");
  const code = await new Promise((resolve) => {
    const child = spawn(forge, forgeScript(p), { cwd: join(ROOT, "crucible-contracts"), stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", resolve);
  });
  if (code !== 0) {
    console.error(`forge script exited ${code}`);
    return code;
  }

  const out = join(ROOT, "out", `deploy-${p.envName}.json`);
  const record = {
    env: p.envName,
    chainId: p.chainId,
    rpcHost: p.rpcHost,
    forgeExit: code,
    addresses: {
      trials: process.env.TRIALS_ADDRESS ?? "",
      alloy: process.env.ALLOY_ADDRESS ?? "",
    },
  };
  for (const [name, addr] of Object.entries(record.addresses)) {
    record[`hasCode_${name}`] = addr ? await hasCode(p.rpcUrl, addr) : false;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`deployment record: ${out}`);
  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  main().then((c) => process.exit(c));
}
