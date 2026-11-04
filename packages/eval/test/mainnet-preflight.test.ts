import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const SENTINEL = "0x0000000000000000000000000000000000000001";
const SINGLETON = "0x" + "77".repeat(20);
const CODE_HASH = "0x" + "aa".repeat(32);
const SAFE_OWNERS = ["0x" + "11".repeat(20), "0x" + "22".repeat(20), "0x" + "33".repeat(20)];
const TRIALS_CONTRACT = "0x" + "44".repeat(20);
const TREASURY_ADDRESS = "0x" + "55".repeat(20);
const OWNER_ADDRESS = "0x" + "66".repeat(20);
const RELEASE_COMMIT = "abcdef1234567";

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
}

function run(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
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
          return ok(slot === "0x0" ? "0x" + addressWord(SINGLETON) : "0x" + "00".repeat(32));
        }
        case "web3_sha3":
          return ok(options.codeHash ?? CODE_HASH);
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
    JSON.stringify({ signed: true, auditor: "0x" + "11".repeat(20), reportHash: "0x" + "22".repeat(32), commit: RELEASE_COMMIT }),
  );
  writeFileSync(
    join(dir, "legal-signoff.json"),
    JSON.stringify({ signed: true, entity: "Crucible Ltd", counsel: "counsel@example.test", tosVersion: "v1" }),
  );
  writeFileSync(
    join(dir, "genesis-cohort.json"),
    JSON.stringify({ signed: true, sponsors: ["0x" + "33".repeat(20)], agents: ["0x" + "44".repeat(20)], epochCapEth: "10" }),
  );
  writeFileSync(
    join(dir, "timelock.json"),
    JSON.stringify({ signed: true, multisig: "0x" + "55".repeat(20), timelockHours: 48, signers: ["0x" + "66".repeat(20)] }),
  );
  writeFileSync(
    join(dir, "monitoring.json"),
    JSON.stringify({ signed: true, oncall: "oncall@example.test", alertChannel: "#crucible-alerts", dashboards: ["hall"] }),
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
      verifiedBy: "reviewer@example.test",
      deploymentCommit: RELEASE_COMMIT,
      evidenceHash: "0x" + "88".repeat(32),
    }),
  );
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
  it("refuses the unsigned production templates and the missing RPC", async () => {
    const res = await run([]);
    expect(res.status).toBe(1);
    for (const file of [
      "audit-signoff.json",
      "legal-signoff.json",
      "genesis-cohort.json",
      "timelock.json",
      "monitoring.json",
      "treasury.json",
    ]) {
      expect(res.stderr).toContain(`${file} is not signed`);
    }
    expect(res.stderr).toContain("MAINNET_RPC_URL not set");
  });

  it("passes a fully signed set against a chain-id-1 RPC with a verified Safe fixture", async () => {
    const dir = signedDir();
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url, TRIALS_ADDRESS: TRIALS_CONTRACT });
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
        MAINNET_RPC_FALLBACK_URL: server.url,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("RPC reports chain id 1");
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

  it("refuses a Safe singleton runtime hash mismatch", async () => {
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
    const record = JSON.parse(await import("node:fs").then(({ readFileSync }) => readFileSync(recordPath, "utf8")));
    record.treasurySafe.address = "0x" + "aa".repeat(20);
    writeFileSync(recordPath, JSON.stringify(record));
    try {
      const res = await run(["--signoffs", dir], {
        MAINNET_RPC_URL: server.url,
        TRIALS_ADDRESS: TRIALS_CONTRACT,
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
    const record = JSON.parse(await import("node:fs").then(({ readFileSync }) => readFileSync(recordPath, "utf8")));
    record.ownerSafe.address = "0x" + "bb".repeat(20);
    writeFileSync(recordPath, JSON.stringify(record));
    try {
      const res = await run(["--signoffs", dir], {
        MAINNET_RPC_URL: server.url,
        TRIALS_ADDRESS: TRIALS_CONTRACT,
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
    const record = JSON.parse(await import("node:fs").then(({ readFileSync }) => readFileSync(recordPath, "utf8")));
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
      const res = await run(["--signoffs", dir, "--params", params], { MAINNET_RPC_URL: server.url, TRIALS_ADDRESS: TRIALS_CONTRACT });
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
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url, TRIALS_ADDRESS: TRIALS_CONTRACT });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("audit-signoff.json missing field commit");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
