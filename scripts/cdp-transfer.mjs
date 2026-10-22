#!/usr/bin/env node
/**
 * CDP Payments: validate-then-execute a USDC transfer, with the HTTP headers on
 * both sides of every call printed (credential values redacted).
 *
 * The headers are the point. `Idempotency-Key` is what makes the execute call
 * safe to retry: the API replays the first response for a key it has already
 * seen, so a lost connection mid-transfer does not mean a second transfer. The
 * key is therefore derived from the run id, not from the clock — re-running with
 * CDP_RUN_ID=<the id this script printed> re-sends the same key instead of
 * creating a new one.
 *
 * Sandbox is the default and the only mode this script will execute in without
 * an explicit flag. Sandbox balances are simulated; the reserved target address
 * below always settles.
 */
import {
  api,
  cdpConfig,
  configure,
  credentialProblem,
  findCdpBin,
  header,
} from "./lib/cdp-cli.mjs";

// Reserved sandbox destination in the CDP quickstart: transfers to it settle.
const RESERVED_TARGET = "0x1111111111111111111111111111111111111111";

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--") ? args[idx + 1] : fallback;
}
function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const cfg = cdpConfig();
const bin = findCdpBin();
const validateOnly = flag("validate-only");
const asset = opt("asset", "usdc");
const amount = opt("amount", "5.00");
const network = opt("network", "base");
const target = opt("target", RESERVED_TARGET);
const pollTimeoutS = Number(opt("poll-timeout", "60"));
const runId =
  process.env.CDP_RUN_ID?.trim() ||
  `crucible-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

if (!/^[0-9]+(\.[0-9]+)?$/.test(amount)) die(`--amount must be a plain decimal, got ${amount}`);
if (!/^0x[0-9a-fA-F]{40}$/.test(target)) die(`--target must be a 40-hex-character address, got ${target}`);
if (cfg.live && !cfg.allowLive) die(credentialProblem(cfg));
if (cfg.live && !flag("execute-live")) {
  die(
    "Refusing to execute against CDP live: real funds move on that path. Re-run with " +
      "--execute-live only when a human has approved a live transfer.",
  );
}
const problem = credentialProblem(cfg);
if (problem) die(problem);

const configured = configure(cfg, bin);
if (configured.status !== 0) {
  die(
    `Could not configure the CDP ${cfg.envName} profile: ${(configured.stderr || "")
      .trim()
      .split(/\r?\n/)
      .pop()}`,
  );
}

console.log(
  `\nCDP ${cfg.envName.toUpperCase()} · ${cfg.baseUrl}\nrun id ${runId}` +
    `${process.env.CDP_RUN_ID ? " (reused — a retry replays the same idempotency keys)" : ""}`,
);

function guard(detail) {
  console.error(`\n${detail}`);
  if (/401|unauthorized/i.test(detail)) {
    console.error(
      [
        "",
        "Both stored pairs were rejected here earlier, on the sandbox host and on the live host, so this",
        "is the credential and not the mode. The CLI signs a JWT from the key file's `privateKey` (a PEM EC",
        "key) or from an Ed25519 seed — a Portal *Client* key string will not pass, whichever host uses it.",
        "",
        "Portal -> switch to Sandbox (top-left) -> Settings -> Create **Secret** API Key, enable Accounts,",
        "save the downloaded JSON outside the repository, set CDP_SANDBOX_API_KEY_FILE to its path, and re-run.",
      ].join("\n"),
    );
  }
  process.exit(1);
}

let call;
try {
  call = api(cfg, bin, ["/platform/v2/accounts"]);
} catch (error) {
  guard(String(error.message));
}

function callApi(fields, opts) {
  try {
    return api(cfg, bin, fields, opts);
  } catch (error) {
    guard(String(error.message));
  }
}

const accounts = call.json?.data ?? call.json?.accounts ?? [];
const wanted = opt("account", cfg.accountId);
const account = wanted
  ? accounts.find((a) => a.id === wanted || a.name === wanted)
  : accounts.find((a) => a.type === "crypto") ?? accounts[0];
if (!account) {
  die(
    `No ${cfg.envName} account${wanted ? ` matching ${wanted}` : ""} in ${JSON.stringify(
      accounts,
    ).slice(0, 160)}.\nCreate one: cdp api -X POST /platform/v2/accounts name="Crucible Agent Sandbox" type=crypto`,
  );
}
console.log(`account ${account.id} · ${account.name ?? "(unnamed)"} · ${account.type ?? "?"}`);

const balances = callApi([`/platform/v2/accounts/${account.id}/balances`,
  header("X-Crucible-Run", runId)], { quiet: true });
const holdings = balances.json?.data ?? balances.json?.balances ?? [];
console.log(
  `balances  ${
    holdings
      .map((b) => `${Number(b.amount ?? b.balance ?? 0).toFixed(2)} ${b.asset ?? b.symbol ?? "?"}`)
      .join("  ") || "(none reported)"
  }`,
);

const common = [
  `source.accountId=${account.id}`,
  `source.asset=${asset}`,
  `target.network=${network}`,
  `target.address=${target}`,
  `target.asset=${asset}`,
  `amount=${amount}`,
  `asset=${asset}`,
  header("X-Crucible-Run", runId),
];

console.log("\n[1] validate — no funds move");
const validated = callApi(
  ["-X", "POST", "/platform/v2/transfers", ...common, "validateOnly:=true", "execute:=false",
    header("Idempotency-Key", `${runId}-validate`)],
);
if (validated.status !== 0) process.exit(validated.status ?? 1);

const fees = validated.json?.fees ?? validated.json?.transfer?.fees ?? [];
if (!Array.isArray(fees) || fees.length === 0) {
  console.log("fees      (none in the response — full body below)");
  console.log(JSON.stringify(validated.json, null, 2));
} else {
  console.log("fees");
  for (const fee of fees) {
    console.log(
      `  ${(fee.type ?? fee.kind ?? "fee").padEnd(18)} ${(fee.amount ?? "?").toString().padStart(10)} ${
        fee.asset ?? ""
      } ${fee.bearer ?? ""} ${fee.waived ? "(waived)" : ""}`.trimEnd(),
    );
  }
}

if (validateOnly) {
  console.log("\nStopped after validate, as asked. Nothing moved.");
  process.exit(0);
}

console.log(`\n[2] execute ${amount} ${asset} on ${network} -> ${target}`);
const executed = callApi(
  ["-X", "POST", "/platform/v2/transfers", ...common, "execute:=true",
    header("Idempotency-Key", `${runId}-execute`)],
);
if (executed.status !== 0) process.exit(executed.status ?? 1);

const transferId =
  executed.json?.transferId ?? executed.json?.transfer?.id ?? executed.json?.id ?? null;
if (!transferId) {
  console.log("No transfer id in the response — full body:");
  console.log(JSON.stringify(executed.json, null, 2));
  process.exit(1);
}

console.log(`\n[3] poll ${transferId}`);
const deadline = Date.now() + pollTimeoutS * 1000;
let status = executed.json?.status ?? "unknown";
let last;
const seen = new Set();
while (!["settled", "failed", "cancelled"].includes(status)) {
  last = callApi([`/platform/v2/transfers/${transferId}`, header("X-Crucible-Run", runId)], {
    quiet: true,
  });
  status = last.json?.status ?? last.json?.transfer?.status ?? status;
  if (!seen.has(status)) {
    seen.add(status);
    console.log(`  status ${status}`);
  }
  if (["settled", "failed", "cancelled"].includes(status)) break;
  if (Date.now() > deadline) {
    console.log(`\nStill ${status} after ${pollTimeoutS}s — full response:`);
    console.log(JSON.stringify(last?.json, null, 2));
    break;
  }
  sleepSync(2000);
}

console.log("\nSummary");
console.log("| Field | Value |");
console.log("| --- | --- |");
console.log(`| Environment | ${cfg.envName} |`);
console.log(`| Account | ${account.id} |`);
console.log(`| Amount | ${amount} ${asset} |`);
console.log(`| Network → target | ${network} → ${target} |`);
console.log(
  `| Fees | ${
    (Array.isArray(fees) ? fees : []).length
      ? fees.map((f) => `${f.type ?? f.kind ?? "fee"} ${f.amount ?? "?"} ${f.asset ?? ""}`.trim()).join(", ")
      : "none reported"
  } |`,
);
console.log(`| Transfer ID | ${transferId} |`);
console.log(`| Final status | ${status} |`);
console.log(`| Run id | ${runId} |`);
console.log(
  `\nConfirm in the Portal: ${cfg.envName === "sandbox" ? "Sandbox" : "Live"} -> Transactions -> Transfers.` +
    `\nTo replay this run without creating a second transfer: CDP_RUN_ID=${runId}`,
);
