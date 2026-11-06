import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  scorecardPublicationId,
  scorecardTypedData,
  type ScorecardPublication,
} from "@crucible/smith";
import { writeScorecardPublication } from "../src/eval/publication-store.js";

const directories: string[] = [];
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);

async function signedPublication(): Promise<ScorecardPublication> {
  const message = {
    cohort: "pilot-2026",
    chainId: 31337,
    agentId: 7,
    runner: "0x0000000000000000000000000000000000000007",
    scorecardCid: "bafkreigh2akiscaildc3u5v3r6z2tw2bvh6v5k2c4q5q7d4x7j2u7ynk4e",
    scorecardDigest: `0x${"22".repeat(32)}` as const,
    issuedAt: 1_800_000_000,
  };
  const signature = await account.signTypedData(scorecardTypedData(message));
  return {
    schemaVersion: 1,
    id: scorecardPublicationId(message),
    signer: account.address,
    message,
    signature,
  };
}

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "crucible-scorecards-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  while (directories.length) {
    const path = directories.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe("durable signed scorecard publication store", () => {
  it("publishes atomically and treats the same signed envelope as an idempotent replay", async () => {
    const dir = directory();
    const publication = await signedPublication();

    const first = writeScorecardPublication(dir, publication);
    const replay = writeScorecardPublication(dir, publication);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(readFileSync(first.path, "utf8")).toContain(publication.signature);
  });

  it("refuses a different envelope under the same replay key", async () => {
    const dir = directory();
    const publication = await signedPublication();
    writeScorecardPublication(dir, publication);

    expect(() => writeScorecardPublication(dir, {
      ...publication,
      signature: `0x${"33".repeat(65)}` as `0x${string}`,
    })).toThrow(/replay conflict/);
  });

  it("blocks a replay of the same scorecard with a fresh publication time", async () => {
    const dir = directory();
    const original = await signedPublication();
    writeScorecardPublication(dir, original);
    const message = { ...original.message, issuedAt: original.message.issuedAt + 1 };
    const replay = {
      ...original,
      message,
      id: scorecardPublicationId(message),
      signature: await account.signTypedData(scorecardTypedData(message)),
    };

    expect(replay.id).toBe(original.id);
    expect(() => writeScorecardPublication(dir, replay)).toThrow(/replay conflict/);
  });

  it("refuses an id that does not identify its signed message", async () => {
    const dir = directory();
    const publication = await signedPublication();

    expect(() => writeScorecardPublication(dir, {
      ...publication,
      id: `0x${"44".repeat(32)}`,
    })).toThrow(/id does not match/);
  });
});
