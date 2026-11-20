import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

/**
 * The mainnet preflight is a gate only if it can be shown to refuse and to pass.
 * The RPC fixture exercises the actual read-only Safe checks: proxy bytecode hash,
 * singleton slot and bytecode hash, threshold, owners, modules and extension slots.
 * It is a deterministic contract fixture, not evidence of a deployed production Safe.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../../scripts/mainnet-preflight.mjs", import.meta.url));
const ZERO = "0x0000000000000000000000000000000000000000";
const SINGLETON = "0x" + "77".repeat(20);
const CODE_HASH = "0x" + "aa".repeat(32);
const SAFE_OWNERS = ["0x" + "11".repeat(20), "0x" + "22".repeat(20), "0x" + "33".repeat(20)];
const TRIALS_CONTRACT = "0x" + "44".repeat(20);
const TREASURY_ADDRESS = "0x" + "55".repeat(20);
const OWNER_ADDRESS = "0x" + "66".repeat(20);
const RELEASE_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
interface RpcOptions {
  threshold?: number;
  owners?: string[];
  modules?: string[];
  codeHash?: string;
  hashMismatchAt?: number;
  extensionStorage?: boolean;
}

function run(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const effectiveArgs = [...args];
  const signoffsIndex = args.indexOf("--signoffs");
  if (signoffsIndex >= 0 && !args.includes("--treasury-adr")) {
    effectiveArgs.push("--treasury-adr", join(args[signoffsIndex + 1], "treasury-adr.md"));
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...effectiveArgs], {
      cwd: ROOT,
      env: { ...process.env, MAINNET_RPC_URL: "", MAINNET_RPC_FALLBACK_URL: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function word(value: number | bigint): string {
  return BigInt(value).toString(16).padStart(64, "0");
}
function addressWord(address: string): string {
  return address.slice(2).toLowerCase().padStart(64, "0");
}
function addressArray(values: string[]): string {
  return "0x" + word(32) + word(values.length) + values.map(addressWord).join("");
}

async function rpc(chainIdHex: string, options: RpcOptions = {}) {
  let hashCalls = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: number;
        method: string;
        params: any[];
      };
      const ok = (result: unknown) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      };
      const fail = (message: string) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message } }));
      };

      switch (request.method) {
        case "eth_chainId":
          return ok(chainIdHex);
        case "eth_getCode":
          return ok("0x60006000");
        case "eth_getStorageAt": {
          const slot = String(request.params[1]).toLowerCase();
          return ok(slot === "0x0" ? "0x" + addressWord(SINGLETON) : options.extensionStorage ? "0x" + word(1) : "0x" + "00".repeat(32));
        }
        case "web3_sha3":
          hashCalls += 1;
          return ok(options.hashMismatchAt === hashCalls ? "0x" + "bb".repeat(32) : options.codeHash ?? CODE_HASH);
        case "eth_call": {
          const data = String(request.params[0]?.data ?? "").toLowerCase();
          if (data.startsWith("0x61d027b3")) return ok("0x" + addressWord(TREASURY_ADDRESS));
          if (data.startsWith("0x8da5cb5b")) return ok("0x" + addressWord(OWNER_ADDRESS));
          if (data.startsWith("0xe75235b8")) return ok("0x" + word(options.threshold ?? 2));
          if (data.startsWith("0xa0e67e2b")) return ok(addressArray(options.owners ?? SAFE_OWNERS));
          if (data.startsWith("0xcc2f8452")) {
            const modules = options.modules ?? [];
            return ok("0x" + word(64) + word(1) + word(modules.length) + modules.map(addressWord).join(""));
          }
          return fail("unexpected eth_call selector");
        }
        default:
          return fail("unexpected method " + request.method);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function safeRecord(address: string) {
  return {
    address,
    singletonAddress: SINGLETON,
    singletonRuntimeCodeHash: CODE_HASH,
    proxyRuntimeCodeHash: CODE_HASH,
    owners: SAFE_OWNERS,
    threshold: 2,
    modules: [],
    guard: ZERO,
    moduleGuard: ZERO,
    fallbackHandler: ZERO,
  };
}

function signedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crucible-mainnet-"));
  writeFileSync(
    join(dir, "audit-signoff.json"),
    JSON.stringify({ signed: true, auditor: "Independent Auditor", reportUrl: "https://auditor.test/reports/crucible", reportHash: "0x" + "22".repeat(32), commit: RELEASE_COMMIT }),
  );
  writeFileSync(
    join(dir, "legal-signoff.json"),
    JSON.stringify({ signed: true, entity: "Crucible Ltd", counsel: "Independent Counsel", tosVersion: "v1", privacyVersion: "v1", licenseVersion: "MIT-0" }),
  );
  writeFileSync(
    join(dir, "genesis-cohort.json"),
    JSON.stringify({ signed: true, sponsors: ["0x" + "33".repeat(20)], agents: ["0x" + "44".repeat(20)], epochCapEth: "10" }),
  );
  writeFileSync(
    join(dir, "timelock.json"),
    JSON.stringify({ signed: true, multisig: OWNER_ADDRESS, timelockHours: 48, signers: SAFE_OWNERS }),
  );
  writeFileSync(
    join(dir, "monitoring.json"),
    JSON.stringify({ signed: true, oncall: "Mainnet Operations Lead", alertChannel: "#crucible-alerts", dashboards: ["hall"] }),
  );
  writeFileSync(
    join(dir, "treasury.json"),
    JSON.stringify({
      signed: true,
      chainId: 1,
      asset: "native-ETH",
      treasurySafe: safeRecord(TREASURY_ADDRESS),
      ownerSafe: safeRecord(OWNER_ADDRESS),
      escrows: {
        legacyTrials: { address: TRIALS_CONTRACT, runtimeCodeHash: CODE_HASH },
      },
      canonicalDeploymentSource: "https://github.com/safe-fndn/safe-deployments/blob/main/src/assets/v1.4.1/safe.json",
      verifiedBy: "Release reviewer",
      deploymentCommit: RELEASE_COMMIT,
      evidenceHash: "0x" + "88".repeat(32),
    }),
  );
  writeFileSync(join(dir, "treasury-adr.md"), "# Treasury ADR acceptance fixture\n- **Status:** Accepted\n");
  return dir;
}

function paramsFile(feeBps: number): string {
  const dir = mkdtempSync(join(tmpdir(), "crucible-params-"));
  writeFileSync(
    join(dir, "crucible.params.json"),
    JSON.stringify({ legacy_fee_bps_v1_frozen: feeBps, fee_bps: 1500, reward_floor: { eth: "0.001" } }),
  );
  return join(dir, "crucible.params.json");
}

describe("mainnet preflight", () => {
  it("reports unresolved ADR, audit and Safe evidence even when the RPC is missing", async () => {
    const res = await run([]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("MAINNET_RPC_URL not set");
    expect(res.stderr).toContain("0020-company-treasury-safe-and-mainnet-release-gate.md is not accepted");
    expect(res.stderr).toContain("audit-signoff.json missing field reportUrl");
    expect(res.stderr).toContain("audit-signoff.json commit must equal checked-out Git HEAD");
    expect(res.stderr).toContain("Treasury Safe.address must be a non-zero address");
    expect(res.stderr).toContain("Treasury Safe.proxyRuntimeCodeHash must be a non-zero bytes32");
    expect(res.stderr).toContain("Owner Safe.address must be a non-zero address");
    expect(res.stderr).toContain("treasury.json verifiedBy is pending or missing");
    expect(res.stderr).toContain("docs/mainnet/legal-signoff.json note contains unresolved placeholder text");
    expect(res.stderr).toContain("docs/mainnet/genesis-cohort.json sponsors[0] is a local development account");
    expect(res.stderr).toContain("docs/mainnet/timelock.json multisig contains unresolved placeholder text");
    expect(res.stderr).toContain("docs/mainnet/monitoring.json alertChannel must not store a Slack webhook URL");
    expect(res.stderr).not.toContain("docs/mainnet/monitoring.json monitors[0].check contains unresolved placeholder text");
    expect(res.stderr).toContain("Safe and escrow addresses are unverified on-chain");
  });

  it("refuses a proposed treasury ADR even when the other release fixtures pass", async () => {
    const dir = signedDir();
    writeFileSync(join(dir, "treasury-adr.md"), "# Treasury ADR acceptance fixture\n- **Status:** Proposed\n");
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url, TRIALS_ADDRESS: TRIALS_CONTRACT, TREASURY_ADDRESS, OWNER_SAFE_ADDRESS: OWNER_ADDRESS });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("treasury-adr.md is not accepted");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses audit evidence pinned to a different commit than the current Git HEAD", async () => {
    const dir = signedDir();
    const auditPath = join(dir, "audit-signoff.json");
    const treasuryPath = join(dir, "treasury.json");
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    const treasury = JSON.parse(readFileSync(treasuryPath, "utf8"));
    audit.commit = "f".repeat(40);
    treasury.deploymentCommit = audit.commit;
    writeFileSync(auditPath, JSON.stringify(audit));
    writeFileSync(treasuryPath, JSON.stringify(treasury));
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url, TRIALS_ADDRESS: TRIALS_CONTRACT, TREASURY_ADDRESS, OWNER_SAFE_ADDRESS: OWNER_ADDRESS });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("audit-signoff.json commit must equal checked-out Git HEAD");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a treasury deployment record pinned to a different commit than the current Git HEAD", async () => {
    const dir = signedDir();
    const treasuryPath = join(dir, "treasury.json");
    const treasury = JSON.parse(readFileSync(treasuryPath, "utf8"));
    treasury.deploymentCommit = "f".repeat(40);
    writeFileSync(treasuryPath, JSON.stringify(treasury));
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url, TRIALS_ADDRESS: TRIALS_CONTRACT, TREASURY_ADDRESS, OWNER_SAFE_ADDRESS: OWNER_ADDRESS });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("treasury.json deploymentCommit must equal checked-out Git HEAD");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses audit signoff without a report URL", async () => {
    const dir = signedDir();
    const auditPath = join(dir, "audit-signoff.json");
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    delete audit.reportUrl;
    writeFileSync(auditPath, JSON.stringify(audit));
    try {
      const res = await run(["--signoffs", dir]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("audit-signoff.json missing field reportUrl");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["http://auditor.example.test/report", "https://user:pass@auditor.example.test/report"])(
    "refuses a non-HTTPS or credential-bearing audit report URL: %s",
    async (reportUrl) => {
      const dir = signedDir();
      const auditPath = join(dir, "audit-signoff.json");
      const audit = JSON.parse(readFileSync(auditPath, "utf8"));
      audit.reportUrl = reportUrl;
      writeFileSync(auditPath, JSON.stringify(audit));
      try {
        const res = await run(["--signoffs", dir]);
        expect(res.status).toBe(1);
        expect(res.stderr).toContain("audit-signoff.json reportUrl must be an HTTPS URL without embedded credentials");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("passes a fully signed set against a chain-id-1 RPC with a verified Safe fixture", async () => {
    const dir = signedDir();
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url, TRIALS_ADDRESS: TRIALS_CONTRACT, TREASURY_ADDRESS, OWNER_SAFE_ADDRESS: OWNER_ADDRESS });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("all checks pass");
      expect(res.stdout).toContain("Treasury Safe verified");
      expect(res.stdout).toContain("Owner Safe verified");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the second endpoint when the first is unreachable", async () => {
    const dir = signedDir();
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], {
        MAINNET_RPC_URL: "http://127.0.0.1:1",
        TRIALS_ADDRESS: TRIALS_CONTRACT,
        TREASURY_ADDRESS,
        OWNER_SAFE_ADDRESS: OWNER_ADDRESS,
        MAINNET_RPC_FALLBACK_URL: server.url,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("RPC reports chain id 1");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the pre-deployment gate when both approved Safe inputs exist but trials are not deployed yet", async () => {
    const dir = signedDir();
    const recordPath = join(dir, "treasury.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.escrows.legacyTrials.address = "";
    record.escrows.legacyTrials.runtimeCodeHash = "";
    writeFileSync(recordPath, JSON.stringify(record));
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], {
        MAINNET_RPC_URL: server.url,
        TREASURY_ADDRESS,
        OWNER_SAFE_ADDRESS: OWNER_ADDRESS,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("new CrucibleTrials deployment inputs pinned");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses production preflight when the deployment treasury input is missing", async () => {
    const dir = signedDir();
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], {
        MAINNET_RPC_URL: server.url,
        OWNER_SAFE_ADDRESS: OWNER_ADDRESS,
        TRIALS_ADDRESS: TRIALS_CONTRACT,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("TREASURY_ADDRESS must equal treasury.json treasurySafe.address");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses using the same Safe for treasury and owner roles", async () => {
    const dir = signedDir();
    const recordPath = join(dir, "treasury.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.ownerSafe.address = record.treasurySafe.address;
    writeFileSync(recordPath, JSON.stringify(record));
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], {
        MAINNET_RPC_URL: server.url,
        TREASURY_ADDRESS,
        OWNER_SAFE_ADDRESS: TREASURY_ADDRESS,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("Treasury Safe and Owner Safe must be distinct addresses");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a chain that is not mainnet", async () => {
    const dir = signedDir();
    const server = await rpc("0x5");
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("chain id is not 1");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a Safe threshold different from the signed 2-of-3 policy", async () => {
    const dir = signedDir();
    const server = await rpc("0x1", { threshold: 1 });
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("on-chain threshold is not 2");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a Safe owner set different from the approved three signers", async () => {
    const dir = signedDir();
    const server = await rpc("0x1", { owners: [SAFE_OWNERS[0], SAFE_OWNERS[1], "0x" + "99".repeat(20)] });
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url, TREASURY_ADDRESS, OWNER_SAFE_ADDRESS: OWNER_ADDRESS });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("on-chain owner set differs from treasury.json");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-zero Safe guard or fallback extension slot", async () => {
    const dir = signedDir();
    const server = await rpc("0x1", { extensionStorage: true });
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url, TREASURY_ADDRESS, OWNER_SAFE_ADDRESS: OWNER_ADDRESS });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("has a non-zero fallbackHandler configuration");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a Safe singleton runtime hash mismatch", async () => {
    const dir = signedDir();
    const server = await rpc("0x1", { hashMismatchAt: 2 });
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url, TREASURY_ADDRESS, OWNER_SAFE_ADDRESS: OWNER_ADDRESS });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("singleton runtime code hash mismatch");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an enabled Safe module", async () => {
    const dir = signedDir();
    const server = await rpc("0x1", { modules: ["0x" + "99".repeat(20)] });
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("has one or more enabled modules");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a Safe proxy runtime hash mismatch", async () => {
    const dir = signedDir();
    const server = await rpc("0x1", { codeHash: "0x" + "bb".repeat(32) });
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("proxy runtime code hash mismatch");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a CrucibleTrials address that differs from the signed treasury record", async () => {
    const dir = signedDir();
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], {
        MAINNET_RPC_URL: server.url,
        TRIALS_ADDRESS: "0x" + "99".repeat(20),
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("legacyTrials address does not match TRIALS_ADDRESS");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when the on-chain escrow treasury differs from the approved Safe", async () => {
    const dir = signedDir();
    const server = await rpc("0x1");
    // This server returns the approved treasury address only; mutate the signoff to a different Safe.
    const recordPath = join(dir, "treasury.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.treasurySafe.address = "0x" + "aa".repeat(20);
    writeFileSync(recordPath, JSON.stringify(record));
    try {
      const res = await run(["--signoffs", dir], {
        MAINNET_RPC_URL: server.url,
        TRIALS_ADDRESS: TRIALS_CONTRACT,
        TREASURY_ADDRESS: "0x" + "aa".repeat(20),
        OWNER_SAFE_ADDRESS: OWNER_ADDRESS,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("on-chain treasury() does not equal the approved Treasury Safe");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when the on-chain owner differs from the approved Owner Safe", async () => {
    const dir = signedDir();
    const server = await rpc("0x1");
    const recordPath = join(dir, "treasury.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.ownerSafe.address = "0x" + "bb".repeat(20);
    writeFileSync(recordPath, JSON.stringify(record));
    try {
      const res = await run(["--signoffs", dir], {
        MAINNET_RPC_URL: server.url,
        TRIALS_ADDRESS: TRIALS_CONTRACT,
        TREASURY_ADDRESS,
        OWNER_SAFE_ADDRESS: "0x" + "bb".repeat(20),
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("on-chain owner() does not equal the approved Owner Safe");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses when the deploy commit differs from the externally audited commit", async () => {
    const dir = signedDir();
    const server = await rpc("0x1");
    const recordPath = join(dir, "treasury.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.deploymentCommit = "123456789abcd";
    writeFileSync(recordPath, JSON.stringify(record));
    try {
      const res = await run(["--signoffs", dir], {
        MAINNET_RPC_URL: server.url,
        TRIALS_ADDRESS: TRIALS_CONTRACT,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("deploymentCommit must match audit-signoff.json commit");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the 15 percent legacy fee", async () => {
    const dir = signedDir();
    const params = paramsFile(1500);
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir, "--params", params], { MAINNET_RPC_URL: server.url, TRIALS_ADDRESS: TRIALS_CONTRACT, TREASURY_ADDRESS, OWNER_SAFE_ADDRESS: OWNER_ADDRESS });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("canonical 500");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(params, ".."), { recursive: true, force: true });
    }
  });

  it("names the field a signature is missing", async () => {
    const dir = signedDir();
    writeFileSync(
      join(dir, "audit-signoff.json"),
      JSON.stringify({ signed: true, auditor: "0x" + "11".repeat(20), reportHash: "0x" + "22".repeat(32) }),
    );
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url, TRIALS_ADDRESS: TRIALS_CONTRACT, TREASURY_ADDRESS, OWNER_SAFE_ADDRESS: OWNER_ADDRESS });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("audit-signoff.json missing field commit");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
