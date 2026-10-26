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
 *
 * The real tree is the refusal case: five unsigned sign-offs and no `MAINNET_RPC_URL`, which
 * is the intended state until humans sign. The pass case is a fully signed temp directory and
 * a local RPC that answers chain id 1 — no mainnet endpoint and no real signature needed to
 * prove the checks run. The fee test is the ADR-0001 trap: 1500 bps must be refused.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../../scripts/mainnet-preflight.mjs", import.meta.url));

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
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

async function rpc(chainIdHex: string) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: chainIdHex }));
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

function signedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "crucible-mainnet-"));
  writeFileSync(
    join(dir, "audit-signoff.json"),
    JSON.stringify({ signed: true, auditor: "0x" + "11".repeat(20), reportHash: "0x" + "22".repeat(32), commit: "abc123" }),
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
  it("refuses the five real unsigned templates and the missing RPC", async () => {
    const res = await run([]);
    expect(res.status).toBe(1);
    for (const file of [
      "audit-signoff.json",
      "legal-signoff.json",
      "genesis-cohort.json",
      "timelock.json",
      "monitoring.json",
    ]) {
      expect(res.stderr).toContain(`${file} is not signed`);
    }
    expect(res.stderr).toContain("MAINNET_RPC_URL not set");
  });

  it("passes a fully signed set against a chain-id-1 RPC", async () => {
    const dir = signedDir();
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain("all checks pass");
      expect(res.stdout).toContain("RPC reports chain id 1");
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

  it("refuses the 15 percent fee", async () => {
    const dir = signedDir();
    const params = paramsFile(1500);
    const server = await rpc("0x1");
    try {
      const res = await run(["--signoffs", dir, "--params", params], { MAINNET_RPC_URL: server.url });
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
      const res = await run(["--signoffs", dir], { MAINNET_RPC_URL: server.url });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("audit-signoff.json missing field commit");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
