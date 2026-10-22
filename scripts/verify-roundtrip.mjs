#!/usr/bin/env node
/**
 * A full round trip on one trial: pin, run, publish, verify.
 *
 * This is the production caller. `@crucible/argus`, `ContentService` and the cid store each
 * had only test importers before it, which is how a verifier can be fully unit-tested and
 * still be unable to run: the parts that touch the outside world were supplied by the test.
 * Here the spec and suite are real bytes, the suite is executed by a real forge, the run is
 * signed by a real key, and the verdict comes back through `LiveVerifier`.
 *
 * The tamper case is the point of the second half. A claim naming a test the bench does not
 * run has to come back as `break-wins`. If it ever came back `agent-wins`, the re-run would
 * be theatre — a signature that checks out over a claim nobody re-executed.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

// The same gap `scripts/run-forge.mjs` exists for: on Windows Foundry usually sits in
// %USERPROFILE%\.foundryin and is absent from the PATH an npm child inherits, so a
// bench that spawns `forge` by name cannot find it. Prepending it here is what lets the
// re-run execute on a dev box; CI and the VPS already have it on PATH.
const foundryBin = process.env.FOUNDRY_BIN ?? pathJoin(homedir(), ".foundry", "bin");
if (existsSync(foundryBin) && !process.env.PATH.split(path.delimiter).includes(foundryBin)) {
  process.env.PATH = `${foundryBin}${path.delimiter}${process.env.PATH}`;
}
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { join as pathJoin } from "node:path";
import { CidStore, ContentBridge, DisclosureLog } from "@crucible/cidstore";
import { ContentService, DEFAULT_SANDBOX, Sandbox } from "@crucible/forge-runner";
import { computeRunHash, digestOfContent, parseForgeTests } from "@crucible/smith";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "fixtures/trials/counter");
const RUNNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TRIALS = "0x5fbdb2315678afecb367f032d93f642f63180aa3";
const CHAIN_ID = 31337;
const SIG_DEADLINE = 4_000_000_000n;

function forge(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts/run-forge.mjs"), ...args], { cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

async function service(dir) {
  return new ContentService({
    bridge: new ContentBridge({
      store: new CidStore({ dir: path.join(dir, "store") }),
      disclosure: await DisclosureLog.open(path.join(dir, "disclosure")),
      digestOf: digestOfContent,
    }),
  });
}

/**
 * Pin what the bench holds, through the same `uploadRepo` a runner uses.
 *
 * The local fallback is deliberate and it is said out loud: this box has no container
 * runtime, so the tree is walked on the host. Listing and pinning are the parts under test
 * here; the isolation those same caps provide is asserted in the forge-runner Docker suite,
 * which skips rather than passes silently when Docker is missing.
 */
async function pinRepo(content, tree) {
  // `uploadRepo` walks a bench with POSIX `find`, which the container has and a Windows dev
  // box does not. The pinned bytes are identical either way — the same FileTree, the same
  // cid — so the round trip pins the tree it already read and leaves the shell walk to the
  // forge-runner tests and to a Docker-backed run.
  if (process.platform === "win32") return (await content.pinSuite(tree)).cid;
  const sandbox = await Sandbox.create({ forceLocal: true, allowLocalFallback: true });
  try {
    for (const [rel, text] of Object.entries(tree.files)) await sandbox.writeFile(rel, text);
    return await content.uploadRepo(sandbox);
  } finally {
    await sandbox.cleanup();
  }
}

/** The repo tree as a pinned FileTree, so the verifier fetches the same bytes it checks. */
async function readTree(root) {
  const files = {};
  for (const rel of ["foundry.toml", "src/Counter.sol", "test/Counter.t.sol"]) {
    files[rel] = await readFile(path.join(root, rel), "utf8");
  }
  return { files };
}

async function main() {
  const work = await mkdtemp(path.join(tmpdir(), "crucible-roundtrip-"));
  const content = await service(work);
  const failures = [];

  try {
    // ── pin before anything is claimed ─────────────────────────────────────
    const specText = existsSync(path.join(FIXTURES, "SPEC.md"))
      ? await readFile(path.join(FIXTURES, "SPEC.md"), "utf8")
      : "The counter must refuse to wrap. Incrementing at the maximum value reverts rather than returning zero.";
    const spec = await content.pinText(specText);
    const suite = await content.pinSuite(await readTree(FIXTURES));

    console.log("pinned spec   ", spec.cid.slice(0, 18) + "…", spec.digest.slice(0, 12) + "…");
    console.log("pinned suite  ", suite.cid.slice(0, 18) + "…", suite.digest.slice(0, 12) + "…");

    // ── run the real suite, and let forge decide what passed ───────────────
    const tree = await readTree(FIXTURES);
    const bench = path.join(work, "bench");
    await mkdir(path.join(bench, "src"), { recursive: true });
    await mkdir(path.join(bench, "test"), { recursive: true });
    for (const [rel, text] of Object.entries(tree.files)) {
      await writeFile(path.join(bench, rel), text, "utf8");
    }
    const ran = await forge(["test", "--json"], bench);
    if (ran.code !== 0) {
      console.error("the fixture suite itself failed:\n" + ran.stdout + ran.stderr);
      process.exit(1);
    }
    // The claim is built from the parser's own reading of forge, so the re-run has
    // something to compare against. Deriving the names by regex here would let the claim be
    // right while the thing the verifier parses is wrong.
    const results = parseForgeTests(ran.stdout);
    const names = results.map((r) => r.name);
    console.log("forge passed  ", names.join(", "));

    const account = privateKeyToAccount(RUNNER_KEY);
    const artifactBase = {
      schemaVersion: "1.0.0",
      trialId: 1,
      agentId: 7,
      specCID: spec.cid,
      testsCID: suite.cid,
      repoCID: await pinRepo(content, tree),
      commitSHA: "0".repeat(40),
      suiteCommand: "forge test --json",
      testResults: results,
      logsCID: await content.uploadLogs(ran.stdout),
      durationMs: 1,
      model: "forge",
      startedAt: 1,
      finishedAt: 2,
      runnerAddress: account.address,
      chainId: CHAIN_ID,
      verifyingContract: TRIALS,
    };

    const { LiveVerifier } = await import("@crucible/argus");
    // `allowLocalFallback` and not `forceLocal`: the bench is containerised wherever a
    // container runtime exists — CI, the VPS — and runs on the host here. Still a real
    // execution of a real suite either way; what changes is the isolation, and the artifact
    // the runner produces records `degraded` when it happens, so a claim is never quietly
    // un-sandboxed.
    const verifier = new LiveVerifier({
      content,
      sandboxSpec: { ...DEFAULT_SANDBOX, allowLocalFallback: true, timeoutSec: 300 },
    });

    /** Sign over the artifact's own run hash and announce it, the way a runner would. */
    async function announce(artifact) {
      const runHash = computeRunHash(artifact);
      const signature = await account.signTypedData({
        domain: { name: "Crucible", version: "1", chainId: CHAIN_ID, verifyingContract: TRIALS },
        types: {
          Run: [
            { name: "trialId", type: "uint256" },
            { name: "agentId", type: "uint256" },
            { name: "runHash", type: "bytes32" },
            { name: "sigDeadline", type: "uint64" },
          ],
        },
        primaryType: "Run",
        message: {
          trialId: 1n,
          agentId: BigInt(artifact.agentId),
          runHash,
          sigDeadline: SIG_DEADLINE,
        },
      });
      await content.publishArtifact(artifact, runHash, signature, String(SIG_DEADLINE));
      return runHash;
    }

    const facts = (runHash) => ({
      trialId: 1,
      agentId: 7,
      runHash,
      sigDeadline: SIG_DEADLINE,
      chainId: CHAIN_ID,
      verifyingContract: TRIALS,
      // From the registry. Here the runner key is the registered one, which is the honest
      // baseline; the impostor case below changes exactly this field and nothing else.
      runner: account.address,
    });

    // ── the honest claim ────────────────────────────────────────────────────
    const honest = { ...artifactBase };
    const honestHash = await announce(honest);
    const honestReport = await verifier.verify(facts(honestHash));
    console.log("\nhonest claim  ", honestReport.verdict, "—", honestReport.reason);
    if (honestReport.verdict !== "agent-wins") {
      failures.push(`an honest run did not verify: ${honestReport.verdict} (${honestReport.reason})`);
    }

    // ── the inflated claim: one extra test nobody ran ───────────────────────
    const inflated = {
      ...artifactBase,
      testResults: [...results, { name: "test_never_written", status: "pass", durationMs: 1 }],
    };
    const inflatedHash = await announce(inflated);
    const inflatedReport = await verifier.verify(facts(inflatedHash));
    console.log("inflated claim", inflatedReport.verdict, "—", inflatedReport.reason);
    if (inflatedReport.verdict !== "break-wins") {
      failures.push("a claim naming a test the suite does not run was not caught — the re-run is decorative");
    }

    // ── the wrong signer: registry says somebody else ────────────────────────
    const impostor = await privateKeyToAccount(
      "0x59c6995e998f97a51e2767c046f5c6b7b42d0c4d95c3c6b7a5e2d1c0b9a8f7e6",
    );
    const swapped = { ...artifactBase, runnerAddress: impostor.address };
    const swappedHash = await announce(swapped);
    const swappedReport = await verifier.verify({ ...facts(swappedHash), runner: account.address });
    console.log("wrong key     ", swappedReport.verdict, "—", swappedReport.reason);
    if (swappedReport.verdict === "agent-wins") {
      failures.push("a run signed by an unregistered key was accepted");
    }

    console.log("");
    if (failures.length) {
      for (const f of failures) console.error("x " + f);
      process.exit(1);
    }
    console.log("round trip holds: content pins, the suite re-runs, and two kinds of lie are caught.");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
