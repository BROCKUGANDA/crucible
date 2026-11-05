import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The treasury money journey, end to end, on a live chain.
 *
 * Every claim the treasury workstream makes about production behaviour is
 * exercised here against a real anvil: the deployment script refuses an EOA
 * treasury, the fee becomes a pull credit on the configured treasury contract
 * (read back from the deployed escrow, not from an argument), a real signed run
 * settles it, the ledger replays the settlement into append-only JSONL, and both
 * gate scripts reconcile clean against the chain. This is the edge suite, not a
 * unit test, because every earlier attempt to fake one of these steps asserted a
 * fiction — the value is precisely that anvil, forge, cast and the ledger all
 * run for real.
 *
 * Skipped (loudly) when the Foundry toolchain is absent: this suite needs it,
 * and a skip that does not say so is a green that proves nothing.
 */

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const contractsDir = join(root, "crucible-contracts");
// Foundry's install commonly lives at %USERPROFILE%\.foundry\bin, missing from the
// PATH a CI shell sees (scripts/run-forge.mjs exists for the same reason).
const foundryBin = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".foundry", "bin");
const ANVIL_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;

const stripAnsi = (s) => s.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");

function foundryTool(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const candidate of [exe, join(foundryBin, exe)]) {
    try {
      const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 30_000 });
      if (probe.status === 0) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function run(cmd, args, env = {}, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: contractsDir,
    encoding: "utf8",
    timeout: opts.timeout ?? 180_000,
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** forge prints logs on stderr and colorizes; both streams, ANSI stripped. */
function bothStreams(r) {
  return r.stdout + "\n" + r.stderr;
}

function waitForRpc(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const tick = async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        const body = await res.json();
        if (body.result) return resolvePromise(body.result);
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) return rejectPromise(new Error("anvil did not start"));
      setTimeout(tick, 300);
    };
    tick();
  });
}

function extractAddress(label, output) {
  // forge console.log("Label", addr) prints `Label 0x...` — take the last match so
  // a repeated label names the latest deployment. ANSI stripped first: the label
  // and the address are both colorized in a real capture.
  const matches = [...stripAnsi(output).matchAll(new RegExp(label + "\\s+(0x[0-9a-fA-F]{40})", "g"))];
  assert.ok(matches.length > 0, `could not find ${label} in forge output:\n${stripAnsi(output)}`);
  return matches.at(-1)[1];
}

test("treasury money journey end to end on a live chain", { timeout: 420_000 }, async (t) => {
  const anvilBin = foundryTool("anvil");
  const forgeBin = foundryTool("forge");
  const castBin = foundryTool("cast");
  if (!anvilBin || !forgeBin || !castBin) {
    t.skip(`foundry toolchain not found (anvil=${!!anvilBin} forge=${!!forgeBin} cast=${!!castBin}) — the live-chain journey cannot run here`);
    return;
  }

  // spawn, not spawnSync: on Windows spawnSync waits for the child to EXIT, and a
  // node that never exits would deadlock the suite instead of testing it. The pid
  // is tracked for teardown — an orphaned anvil is exactly what the reaper exists for.
  const anvil = spawn(anvilBin, ["--port", String(PORT), "--silent"], {
    cwd: contractsDir,
    detached: true,
    stdio: "ignore",
  });
  anvil.unref();
  assert.ok(anvil.pid > 0, "anvil spawned");
  t.after(() => {
    try {
      process.kill(anvil.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  });

  await waitForRpc(RPC);

  // Two LocalTreasuryHolder contracts: one treasury, one owner. Deploy.s.sol
  // refuses code-less addresses, so the stand-ins are the local shape of the
  // production Safes (whose real bytecode the mainnet preflight pins).
  const holderSrc = "contracts/mocks/LocalTreasuryHolder.sol:LocalTreasuryHolder";
  const createArgs = ["create", holderSrc, "--rpc-url", RPC, "--private-key", ANVIL_KEY0, "--broadcast"];
  const h1 = run(forgeBin, createArgs, {}, { timeout: 300_000 });
  assert.equal(h1.status, 0, `forge create holder1 failed:\n${bothStreams(h1)}`);
  const h2 = run(forgeBin, createArgs, {}, { timeout: 300_000 });
  assert.equal(h2.status, 0, `forge create holder2 failed:\n${bothStreams(h2)}`);
  // forge create is dry-run unless --broadcast (measured 2026-11-05), and its
  // output is colorized — hence the flag above and the strip here.
  const treasuryHolder = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(stripAnsi(h1.stdout))?.[1];
  const ownerHolder = /Deployed to: (0x[0-9a-fA-F]{40})/.exec(stripAnsi(h2.stdout))?.[1];
  assert.ok(treasuryHolder && ownerHolder, "holders deployed");

  // The deployment itself: the escrow now exists with a contract treasury.
  const deploy = run(
    forgeBin,
    ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", RPC, "--broadcast"],
    { TREASURY_ADDRESS: treasuryHolder, OWNER_SAFE_ADDRESS: ownerHolder, ALLOW_ANVIL_DEV_KEY: "1" },
    { timeout: 420_000 },
  );
  assert.equal(deploy.status, 0, `deploy failed:\n${bothStreams(deploy)}`);
  // forge script prints its Logs section on stderr.
  const trials = extractAddress("CrucibleTrials", bothStreams(deploy));
  assert.notEqual(trials.toLowerCase(), treasuryHolder.toLowerCase(), "escrow and treasury are different contracts");

  // The demo reads the treasury back from the deployed contract — the value the
  // gate later re-checks — never from an argument.
  const demoProbe = run(
    forgeBin,
    ["script", "script/TreasuryPipelineDemo.s.sol:TreasuryPipelineDemo", "--rpc-url", RPC],
    { TRIALS: trials },
    { timeout: 300_000 },
  );
  assert.equal(demoProbe.status, 0, `demo readback failed:\n${bothStreams(demoProbe)}`);
  assert.ok(stripAnsi(bothStreams(demoProbe)).includes(treasuryHolder), "the demo reads the treasury from the chain, not from an argument");

  // Phase A: fund, claim, submit a runner-signed run.
  const begin = run(
    forgeBin,
    ["script", "script/TreasuryPipelineDemo.s.sol:TreasuryPipelineDemo", "--sig", "Begin", "--rpc-url", RPC, "--broadcast"],
    { TRIALS: trials },
    { timeout: 420_000 },
  );
  assert.equal(begin.status, 0, `demo Begin failed:\n${bothStreams(begin)}`);
  const trialId = Number(/trial (\d+)/.exec(bothStreams(begin))?.[1]);
  assert.ok(Number.isFinite(trialId) && trialId > 0, "Begin printed the trial id");

  // The window end is read FROM THE CHAIN, never from the script log: forge
  // script prints simulation-time values while anvil mines real blocks seconds
  // later, so the real runAt is larger than anything Begin printed (measured:
  // a log-derived warp still landed WindowOpen seconds short). runAtOf and
  // breakWindowOf are the contract's own packed timestamps.
  // cast prints `1793835417 [1.793e9]` — the bracketed scientific form is
  // decoration for humans and poison for Number(), so the first token is the value.
  const readOnChain = (sig) =>
    Number(run(castBin, ["call", trials, sig, String(trialId), "--rpc-url", RPC]).stdout.trim().split(/\s+/)[0]);
  const runAt = readOnChain("runAtOf(uint256)(uint64)");
  const breakWindow = readOnChain("breakWindowOf(uint256)(uint64)");
  assert.ok(runAt > 0 && breakWindow > 0, `on-chain timestamps read: runAt=${runAt} breakWindow=${breakWindow}`);

  // Warp past the skeptic window on the node itself, then mine the block.
  const target = runAt + breakWindow + 1;
  const warp = run(castBin, ["rpc", "anvil_setNextBlockTimestamp", String(target), "--rpc-url", RPC]);
  assert.equal(warp.status, 0, `warp failed:\n${bothStreams(warp)}`);
  const mine = run(castBin, ["rpc", "anvil_mine", "1", "--rpc-url", RPC]);
  assert.equal(mine.status, 0, `mine failed:\n${bothStreams(mine)}`);

  // Phase B: finalize, both pulls. The fee reaches the treasury contract.
  const finish = run(
    forgeBin,
    ["script", "script/TreasuryPipelineDemo.s.sol:TreasuryPipelineDemo", "--sig", "Finish", "--rpc-url", RPC, "--broadcast"],
    { TRIALS: trials },
    { timeout: 420_000 },
  );
  assert.equal(finish.status, 0, `demo Finish failed:\n${bothStreams(finish)}`);

  // T4/T6: the ledger replays the settlement and reconciles clean against the chain.
  const ledgerDir = mkdtempSync(join(tmpdir(), "crucible-edge-ledger-"));
  t.after(() => rmSync(ledgerDir, { recursive: true, force: true }));
  const ledgerPath = join(ledgerDir, "ledger.jsonl");
  const reconcileRun = run(
    "node",
    [join(root, "scripts", "treasury-reconcile.mjs"), "--ledger", ledgerPath],
    { RPC_URL: RPC, TRIALS_ADDRESS: trials, TREASURY_ADDRESS: treasuryHolder },
    { timeout: 120_000 },
  );
  assert.equal(reconcileRun.status, 0, `reconcile failed:\n${bothStreams(reconcileRun)}`);
  const verdict = JSON.parse(reconcileRun.stdout);
  assert.equal(verdict.ok, true, "reconcile verdict is ok");
  // fee-credited + win-paid + two withdrawals (treasury pull, agent payout).
  assert.equal(verdict.totalEntries, 4, `expected 4 ledger entries, got ${verdict.totalEntries}`);
  assert.ok(existsSync(ledgerPath), "the ledger file exists on disk");
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 4, "one JSON line per entry");
  const types = lines.map((l) => JSON.parse(l).type).sort();
  assert.deepEqual(types, ["fee-credited", "win-paid", "withdrawal", "withdrawal"]);
  // Reconcile is idempotent: a second run appends nothing and stays ok.
  const second = run(
    "node",
    [join(root, "scripts", "treasury-reconcile.mjs"), "--ledger", ledgerPath],
    { RPC_URL: RPC, TRIALS_ADDRESS: trials, TREASURY_ADDRESS: treasuryHolder },
    { timeout: 120_000 },
  );
  assert.equal(second.status, 0, `second reconcile failed:\n${bothStreams(second)}`);
  assert.equal(JSON.parse(second.stdout).appendedEntries, 0, "the second replay appends nothing");

  // T7: the release gate passes against this chain — treasury destination, fee law,
  // owner boundary, conservation, reconciliation.
  const gate = run(
    "node",
    [join(root, "scripts", "treasury-release-gate.mjs")],
    { RPC_URL: RPC, TRIALS_ADDRESS: trials, TREASURY_ADDRESS: treasuryHolder, FINANCE_LEDGER: ledgerPath },
    { timeout: 120_000 },
  );
  assert.equal(gate.status, 0, `gate failed:\n${bothStreams(gate)}`);
  const gateVerdict = JSON.parse(gate.stdout);
  assert.equal(gateVerdict.ok, true, "gate verdict is ok");
  assert.deepEqual(
    gateVerdict.checks.map((c) => c.name),
    ["treasury-destination", "fee-law", "owner-boundary", "conservation", "reconciliation"],
  );
});
