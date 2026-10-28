#!/usr/bin/env node
/**
 * Prove the public RPC endpoint is actually behind the method gate.
 *
 * The gate's own unit tests start the gate in-process, so they prove the code refuses
 * `anvil_setBalance` — they cannot prove the deployed edge ROUTES to the gate. On
 * 2026-10-27 the live scan said otherwise: `eth_accounts` answered with the node's ten
 * unlocked dev signers, and `anvil_setBalance` came back with anvil's own parameter
 * error (`-32602 expected ... SetBalance with 2 elements`), which is text only the node
 * can produce. The installed edge directory predated the gate commit, and a bind-mounted
 * Caddyfile is not reloaded (this edge runs with `admin off`), so the route that shipped
 * in review still pointed at `anvil:8545`.
 *
 * So this file is the check the deployment runs: it asks the endpoint, over the network,
 * for the methods that must never reach a node, and it accepts exactly one answer —
 * the gate's refusal. A 200, a node-side `-32602`, a 502, or an unparseable body is a
 * failure, because every one of those means the request got as far as something that
 * speaks the node's language.
 *
 * Exit 0 = every refusal held and the wallet path still works. Exit 1 = at least one
 * method reached the node; the endpoint is public and the chain is griefable.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

/** The refusal this gate emits: HTTP 403 with the JSON-RPC "not available" code. */
const REFUSED_STATUS = 403;
const REFUSED_CODE = -32601;

/**
 * The node-control methods, with the arguments a real caller would send.
 *
 * Args matter: `anvil_setBalance` with no params is rejected by the node for the wrong
 * reason, and a check that passes on a parameter-length error learns nothing. These are
 * the exact calls that would rewrite the demo chain's state.
 */
export const MUST_BE_REFUSED = [
  { method: "eth_accounts", params: [] },
  { method: "anvil_setBalance", params: ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x21e19e0c9bab2400000"] },
  { method: "anvil_impersonateAccount", params: ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"] },
  { method: "anvil_setNextBlockTimestamp", params: [1893456000] },
  { method: "anvil_mine", params: [1] },
  { method: "evm_mine", params: [] },
  { method: "personal_sign", params: ["0x68656c6c6f", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"] },
  { method: "eth_sendTransaction", params: [{ from: "0x0000000000000000000000000000000000000000" }] },
];

function parseArgs(argv) {
  const out = { url: undefined, connectTo: undefined, servername: undefined, insecure: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--connect-to") out.connectTo = argv[++i];
    else if (a === "--servername") out.servername = argv[++i];
    else if (a === "--insecure") out.insecure = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.url) throw new Error("usage: probe.mjs --url <rpc-endpoint> [--connect-to host:port] [--servername tls-name] [--insecure]");
  return out;
}

/**
 * One JSON-RPC call, returning the transport facts the verdict depends on.
 *
 * `body` is kept raw so a refusal can be identified by its code rather than by a
 * substring of prose a future message tweak could break.
 */
function rpcCall(url, opts, payload, timeoutMs = 20000) {
  const target = new URL(url);
  const [connectHost, connectPort] = opts.connectTo ? opts.connectTo.split(":") : [target.hostname, target.port];
  const useHttps = target.protocol === "https:";
  const reqOpts = {
    host: connectHost || target.hostname,
    port: Number(connectPort || (useHttps ? 443 : 80)),
    path: `${target.pathname}${target.search}`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The bare hostname, port stripped. This mirrors what the browser sends: the
      // front door terminates at 443 and the edge is reached on 8444, so the Host
      // header a visitor produces never carries the edge's port. A probe that sent
      // "name:8444" would be testing a request shape nobody makes.
      host: target.hostname,
      "content-length": Buffer.byteLength(payload),
    },
    servername: opts.servername,
    rejectUnauthorized: opts.insecure ? false : undefined,
    timeout: timeoutMs,
  };
  const send = useHttps ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const req = send(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => resolve({ status: 0, body: `transport error: ${err.message}` }));
    req.end(payload);
  });
}

/** A refusal is 403 carrying -32601. Anything else means the call was answered elsewhere. */
export function isRefusal({ status, body }) {
  if (status !== REFUSED_STATUS) return false;
  try {
    const parsed = JSON.parse(body);
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    return calls.length > 0 && calls.every((c) => c && c.error && c.error.code === REFUSED_CODE);
  } catch {
    return false;
  }
}

export async function probe(url, opts = {}) {
  const rows = [];

  // The wallet path must still work. A gate that refuses everything is a broken site,
  // and a broken site is what an operator would notice first — so this probe earns its
  // place by distinguishing "refused the node" from "refused the product".
  const read = await rpcCall(url, opts, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
  let readOk = false;
  try {
    readOk = typeof JSON.parse(read.body).result === "string";
  } catch {}
  rows.push({ probe: "eth_chainId (wallet read must pass)", ok: read.status === 200 && readOk, response: `${read.status} ${read.body.slice(0, 160)}` });

  for (const { method, params } of MUST_BE_REFUSED) {
    const res = await rpcCall(url, opts, JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }));
    rows.push({ probe: `${method} (must never reach the node)`, ok: isRefusal(res), response: `${res.status} ${res.body.slice(0, 160)}` });
  }

  // One forbidden method smuggled inside an otherwise-valid batch: the gate must refuse
  // the whole call, not forward the batch because its first element is allowed.
  const batch = await rpcCall(url, opts, JSON.stringify([
    { jsonrpc: "2.0", id: 3, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 4, method: "anvil_mine", params: [1] },
  ]));
  rows.push({ probe: "batch smuggling (one forbidden method in a valid batch)", ok: isRefusal(batch), response: `${batch.status} ${batch.body.slice(0, 160)}` });

  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseArgs(process.argv.slice(2));
  const rows = await probe(opts.url, opts);
  let failed = 0;
  for (const row of rows) {
    console.log(`${row.ok ? "PASS" : "FAIL"}  ${row.probe}\n      ${row.response}`);
    if (!row.ok) failed += 1;
  }
  if (failed > 0) {
    console.error(`\n${failed} of ${rows.length} probes failed: ${opts.url} is NOT gated — the node answers it.`);
    process.exit(1);
  }
  console.log(`\n${rows.length}/${rows.length} probes as expected: ${opts.url} refuses the node's control surface and still serves the wallet.`);
}
