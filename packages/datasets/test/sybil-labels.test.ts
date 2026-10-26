import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const FIXTURES = fileURLToPath(new URL("../fixtures/sybil-labels/", import.meta.url));
const LABELER = fileURLToPath(new URL("../../../scripts/label-identity-corpus.mjs", import.meta.url));
const CHAIN_NOW = 1_800_000_000;

function readJsonl(name: string): Record<string, any>[] {
  return readFileSync(join(FIXTURES, name), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => JSON.parse(line));
}

function labelMessage(wallet: string, label: number, issuedAt: number, expiry: number): string {
  return [
    "Crucible label attestation",
    `wallet: ${wallet.toLowerCase()}`,
    `label: ${label}`,
    `issuedAt: ${issuedAt}`,
    `expiry: ${expiry}`,
  ].join("\n");
}

function runLabeler(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [LABELER, ...args], {
    encoding: "utf8",
    env: { ...process.env, IDENTITY_ATTESTORS: "", ...env },
  });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "crucible-sybil-"));
}

const issuer = readFileSync(join(FIXTURES, "issuer.txt"), "utf8").trim();
const corpus = readJsonl("corpus.jsonl");
const proofs = new Map(readJsonl("proofs.jsonl").map((p) => [String(p.wallet).toLowerCase(), p]));
const sheet = readJsonl("sheet.jsonl");

describe("signed sybil labels", () => {
  it("every label is a signature from the named issuer", async () => {
    expect(corpus).toHaveLength(80);
    expect(corpus.filter((r) => r.label === 1)).toHaveLength(40);
    expect(corpus.filter((r) => r.label === 0)).toHaveLength(40);

    for (const row of corpus) {
      const wallet = String(row.wallet).toLowerCase();
      const proof = proofs.get(wallet);
      expect(proof, `no proof for ${wallet}`).toBeDefined();
      if (!proof) continue;
      expect(row.labelIssuer).toBe(issuer);
      const ok = await verifyMessage({
        address: issuer as `0x${string}`,
        message: labelMessage(wallet, row.label, proof.issuedAt, proof.expiry),
        signature: proof.signature,
      });
      expect(ok, `signature did not verify for ${wallet}`).toBe(true);
    }
  });

  it("does not label a wallet from its trial verdict", () => {
    // The sheet has features and no verdicts. Add a wallet whose verdict screams "bad" and
    // whose features look bad, but with no signed label — it must not enter the corpus.
    const dir = tempDir();
    try {
      const extra = "0x" + "ee".repeat(20);
      const augmented = [
        ...sheet,
        { wallet: extra, agentId: 999, features: { hasSlashes: true, hasWonTrial: true }, verdict: "slashed" },
      ];
      const sheetPath = join(dir, "sheet.jsonl");
      const outPath = join(dir, "corpus.jsonl");
      writeFileSync(sheetPath, augmented.map((r) => JSON.stringify(r)).join("\n") + "\n");

      const res = runLabeler([
        "--sheet", sheetPath,
        "--proofs", join(FIXTURES, "proofs.jsonl"),
        "--attestors", issuer,
        "--chain-now", String(CHAIN_NOW),
        "--out", outPath,
      ]);
      expect(res.status, res.stderr).toBe(0);

      const out = readFileSync(outPath, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.trim().startsWith("#"))
        .map((line) => JSON.parse(line));
      expect(out).toHaveLength(80);
      expect(out.some((r) => String(r.wallet).toLowerCase() === extra)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to invent a corpus with no named issuer", () => {
    const dir = tempDir();
    try {
      const res = runLabeler([
        "--sheet", join(FIXTURES, "sheet.jsonl"),
        "--proofs", join(FIXTURES, "proofs.jsonl"),
        "--chain-now", String(CHAIN_NOW),
        "--out", join(dir, "unused.jsonl"),
      ]);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/no issuer is named/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a corpus below the class floor", () => {
    const dir = tempDir();
    try {
      const sheetPath = join(dir, "small-sheet.jsonl");
      writeFileSync(sheetPath, sheet.slice(0, 10).map((r) => JSON.stringify(r)).join("\n") + "\n");
      const res = runLabeler([
        "--sheet", sheetPath,
        "--proofs", join(FIXTURES, "proofs.jsonl"),
        "--attestors", issuer,
        "--chain-now", String(CHAIN_NOW),
        "--out", join(dir, "small-corpus.jsonl"),
      ]);
      expect(res.status).toBe(2);
      expect(res.stderr).toMatch(/only 10 labelled rows/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops an expired label on the chain clock", () => {
    const dir = tempDir();
    try {
      const expired = "0x" + "00".repeat(20);
      const altered = readJsonl("proofs.jsonl").map((p) =>
        String(p.wallet).toLowerCase() === expired ? { ...p, expiry: 1 } : p,
      );
      const proofsPath = join(dir, "proofs.jsonl");
      const outPath = join(dir, "corpus.jsonl");
      writeFileSync(proofsPath, altered.map((p) => JSON.stringify(p)).join("\n") + "\n");

      const res = runLabeler([
        "--sheet", join(FIXTURES, "sheet.jsonl"),
        "--proofs", proofsPath,
        "--attestors", issuer,
        "--chain-now", String(CHAIN_NOW),
        "--out", outPath,
      ]);
      expect(res.status, res.stderr).toBe(0);
      const out = readFileSync(outPath, "utf8");
      expect(out).not.toContain(expired);
      expect(out.trim().split(/\r?\n/).filter((l) => !l.startsWith("#"))).toHaveLength(79);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops a label signed by someone the deployment did not name", async () => {
    const dir = tempDir();
    try {
      const target = "0x" + "00".repeat(20);
      const stranger = privateKeyToAccount("0x" + "77".repeat(32));
      const original = proofs.get(target);
      expect(original).toBeDefined();
      if (!original) return;

      const forged = {
        ...original,
        signature: await stranger.signMessage({
          message: labelMessage(target, original.label, original.issuedAt, original.expiry),
        }),
      };
      const altered = readJsonl("proofs.jsonl").map((p) =>
        String(p.wallet).toLowerCase() === target ? forged : p,
      );
      const proofsPath = join(dir, "proofs.jsonl");
      const outPath = join(dir, "corpus.jsonl");
      writeFileSync(proofsPath, altered.map((p) => JSON.stringify(p)).join("\n") + "\n");

      const res = runLabeler([
        "--sheet", join(FIXTURES, "sheet.jsonl"),
        "--proofs", proofsPath,
        "--attestors", issuer,
        "--chain-now", String(CHAIN_NOW),
        "--out", outPath,
      ]);
      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(outPath, "utf8")).not.toContain(target);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
