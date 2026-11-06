import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CidStore } from "@crucible/cidstore";
import {
  buildEvalManifest,
  digestOfContent,
  manifestDigest,
  scorecardPublicationId,
  scorecardTypedData,
  type ScorecardPublication,
} from "@crucible/smith";
import { privateKeyToAccount } from "viem/accounts";
import type { ReadModel } from "@crucible/indexer";
import { createContentSource } from "../src/content.js";
import { createScorecardPublicationSource } from "../src/scorecard-publications.js";
import { buildScorecardIndex, createScorecardRanking } from "../src/scorecard-ranking.js";
import { writeScorecardPublication } from "../../../grader/src/eval/publication-store.js";

/**
 * The run → score join, tested against real signed publications.
 *
 * These are not hand-written scorecard objects. Each fixture signs an EIP-712 publication the way
 * `scripts/grade-arena.mjs` does and writes it through the same store, so the join is exercised on
 * the path the verification code actually accepts — a fixture this file made up on its own would
 * prove that `buildScorecardIndex` agrees with itself.
 *
 * The claims worth defending are the negative ones: no match yields no score, an ambiguous match
 * yields no score, and a scorecard this host refuses to publish yields no score. Each of those is
 * a place a leaderboard would rather have a number than admit it has none.
 */

const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"22".repeat(32)}`);
const chainId = 31337;
const agentId = 7;
const runner = "0x0000000000000000000000000000000000000007" as const;
const suiteEpoch = `0x${"aa".repeat(32)}` as const;
const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.shift()!, { recursive: true, force: true });
});

function manifest(over: Partial<ReturnType<typeof buildEvalManifest>> = {}) {
  return buildEvalManifest({
    taskDigest: suiteEpoch,
    suiteDigest: suiteEpoch,
    evaluator: { id: "grader", version: "1.0.0" },
    model: { provider: "fixture-provider", name: "model-a", version: "2026-01-01" },
    environment: { imageDigest: suiteEpoch, networkPolicy: "none" },
    seed: "fixture-seed",
    scoring: { feeSchedule: "none", feeScheduleVersion: "0", decision: "deterministic-suite" },
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...over,
  });
}

interface PublicationOptions {
  cohort?: string;
  agentId?: number;
  accuracy?: number;
  /** Write the row's accuracy as a string, which verification accepts and the join must not. */
  rawAccuracy?: string;
  disqualified?: boolean;
  manifestOverride?: ReturnType<typeof manifest>;
  invalidSignature?: boolean;
  untrustedSigner?: boolean;
}

async function publication(options: PublicationOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "crucible-ranking-"));
  directories.push(root);
  const contentDir = join(root, "content");
  const publicationsDir = join(contentDir, "scorecards", "publications");
  mkdirSync(publicationsDir, { recursive: true });
  const store = new CidStore({
    dir: join(contentDir, "scorecards", "store"),
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxEntries: Number.MAX_SAFE_INTEGER,
    maxEntryBytes: Number.MAX_SAFE_INTEGER,
  });

  const payload = { claim: "probe-one", evidence: "the exact fixture bytes" };
  const corpusText = JSON.stringify([{ claimHash: "claim-one", payload }]);
  const corpusRef = { cid: store.put(corpusText), digest: digestOfContent(corpusText) };
  const rowManifest = options.manifestOverride ?? manifest();
  const agent = options.agentId ?? agentId;

  const record = {
    kind: "crucible/arena-scorecard",
    version: 1,
    generatedAt: 1_800_000_000_000,
    publication: {
      cohort: options.cohort ?? "pilot-2026",
      chainId,
      agentId: agent,
      runner,
      issuedAt: 1_800_000_001,
      signer: signer.address,
    },
    corpus: { suite: "smoke", artifacts: 1 },
    corpusEvidence: corpusRef,
    trajectories: [],
    rows: [
      {
        modelId: "model-a",
        suite: "smoke",
        suiteEpoch,
        manifest: rowManifest,
        manifestDigest: manifestDigest(rowManifest),
        accuracy: options.rawAccuracy ?? (options.accuracy ?? 0.5),
        falsePassRate: 0,
        disqualified: options.disqualified ?? false,
      },
    ],
  };
  const scorecardText = JSON.stringify(record);
  const scorecardCid = store.put(scorecardText);
  const message = {
    cohort: options.cohort ?? "pilot-2026",
    chainId,
    agentId: agent,
    runner,
    scorecardCid,
    scorecardDigest: digestOfContent(scorecardText),
    issuedAt: 1_800_000_001,
  };
  const signature = await signer.signTypedData(scorecardTypedData(message));
  const pub: ScorecardPublication = {
    schemaVersion: 1,
    id: scorecardPublicationId(message),
    signer: signer.address,
    message,
    signature: options.invalidSignature ? (`0x${"33".repeat(65)}` as const) : signature,
  };
  if (options.untrustedSigner) {
    // Signed by somebody this host has never authorized.
    pub.signer = stranger.address;
  }
  writeScorecardPublication(publicationsDir, pub);

  const model = {
    trials: new Map(),
    agents: new Map([[agent, { id: agent, runner }]]),
    runs: new Map(),
    disputes: new Map(),
    appliedLogs: new Set<string>(),
    version: 0,
  } as unknown as ReadModel;

  return {
    digest: manifestDigest(rowManifest).toLowerCase(),
    deps: {
      getModel: () => model,
      contentLookup: createContentSource(join(contentDir, "scorecards"), () => new Map()),
      proofSource: {
        chain: "foundry",
        chainId,
        trialsAddress: "0x0000000000000000000000000000000000000001",
      },
      publications: createScorecardPublicationSource(publicationsDir),
      signers: [signer.address],
    },
    publicationsDir,
  };
}

/**
 * Two cohorts, one agent, one manifest, one host.
 *
 * The whole point is that they share a store and a publications directory: the ambiguity only
 * exists for a reader who can actually verify both, and a fixture that split them across hosts
 * would let the join fail for a reason that has nothing to do with the collision.
 */
async function publicationPair(): Promise<{ digest: string; deps: Awaited<ReturnType<typeof publication>>["deps"] }> {
  const root = mkdtempSync(join(tmpdir(), "crucible-ranking-pair-"));
  directories.push(root);
  const contentDir = join(root, "content");
  const publicationsDir = join(contentDir, "scorecards", "publications");
  mkdirSync(publicationsDir, { recursive: true });
  const store = new CidStore({
    dir: join(contentDir, "scorecards", "store"),
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxEntries: Number.MAX_SAFE_INTEGER,
    maxEntryBytes: Number.MAX_SAFE_INTEGER,
  });
  const corpusText = JSON.stringify([{ claimHash: "claim-one", payload: "the exact fixture bytes" }]);
  const corpusRef = { cid: store.put(corpusText), digest: digestOfContent(corpusText) };
  const rowManifest = manifest();
  const digest = manifestDigest(rowManifest).toLowerCase();

  const publish = async (cohort: string, issuedAt: number) => {
    const record = {
      kind: "crucible/arena-scorecard",
      version: 1,
      generatedAt: 1_800_000_000_000,
      publication: { cohort, chainId, agentId, runner, issuedAt, signer: signer.address },
      corpus: { suite: "smoke", artifacts: 1 },
      corpusEvidence: corpusRef,
      trajectories: [],
      rows: [
        {
          modelId: "model-a",
          suite: "smoke",
          suiteEpoch,
          manifest: rowManifest,
          manifestDigest: digest,
          accuracy: 0.5,
          falsePassRate: 0,
          disqualified: false,
        },
      ],
    };
    const scorecardText = JSON.stringify(record);
    const message = {
      cohort,
      chainId,
      agentId,
      runner,
      scorecardCid: store.put(scorecardText),
      scorecardDigest: digestOfContent(scorecardText),
      issuedAt,
    };
    const pub: ScorecardPublication = {
      schemaVersion: 1,
      id: scorecardPublicationId(message),
      signer: signer.address,
      message,
      signature: await signer.signTypedData(scorecardTypedData(message)),
    };
    writeScorecardPublication(publicationsDir, pub);
  };

  await publish("alpha", 1_800_000_001);
  await publish("beta", 1_800_000_002);

  const model = {
    trials: new Map(),
    agents: new Map([[agentId, { id: agentId, runner }]]),
    runs: new Map(),
    disputes: new Map(),
    appliedLogs: new Set<string>(),
    version: 0,
  } as unknown as ReadModel;

  return {
    digest,
    deps: {
      getModel: () => model,
      contentLookup: createContentSource(join(contentDir, "scorecards"), () => new Map()),
      proofSource: { chain: "foundry", chainId, trialsAddress: "0x0000000000000000000000000000000000000001" },
      publications: createScorecardPublicationSource(publicationsDir),
      signers: [signer.address],
    },
  };
}

describe("a scorecard that covers this run's conditions", () => {
  it("joins on (agentId, manifestDigest) and carries the cohort the signer attested", async () => {
    const { digest, deps } = await publication({ accuracy: 0.75, cohort: "arena-q4" });
    const ranking = await createScorecardRanking(deps);
    expect(ranking({ agentId, manifestDigest: digest as `0x${string}` })).toEqual({
      cohortId: "arena-q4",
      score: 0.75,
    });
  });

  /**
   * The agent half of the key is not decoration.
   *
   * Two agents scored under one manifest produced two different measurements, and a join that
   * ignored which agent signed would hand agent 8 the number agent 7 earned. That is a
   * reputation-transfer bug wearing a lookup.
   */
  it("will not give another agent a score it never received", async () => {
    const { digest, deps } = await publication({ accuracy: 0.75 });
    const ranking = await createScorecardRanking(deps);
    expect(ranking({ agentId: 99, manifestDigest: digest as `0x${string}` })).toBeNull();
  });

  it("never fills an uncertainty it did not compute", async () => {
    const { digest, deps } = await publication();
    const ranking = await createScorecardRanking(deps);
    const found = ranking({ agentId, manifestDigest: digest as `0x${string}` })!;
    expect("uncertainty" in found).toBe(false);
  });
});

describe("the refusals", () => {
  it("returns nothing for a digest no row was scored under", async () => {
    const { deps } = await publication();
    const ranking = await createScorecardRanking(deps);
    expect(ranking({ agentId, manifestDigest: `0x${"ff".repeat(32)}` })).toBeNull();
  });

  /**
   * The absent digest, and why it is a separate case.
   *
   * `evaluations-source.ts` hands the join the digest it *recomputed from the pinned bytes* and
   * nulls it when the announced number disagreed. So a run whose evidence failed its own check
   * cannot ride a score in on the very value that was just refused — the alternative is a
   * leaderboard row that is ineligible for evidence integrity and ranked anyway.
   */
  it("returns nothing when the caller has no verified digest to offer", async () => {
    const { deps } = await publication();
    const ranking = await createScorecardRanking(deps);
    expect(ranking({ agentId, manifestDigest: null })).toBeNull();
  });

  it("refuses a disqualified row rather than ranking an invalid measurement", async () => {
    const { digest, deps } = await publication({ accuracy: 0.99, disqualified: true });
    const ranking = await createScorecardRanking(deps);
    expect(ranking({ agentId, manifestDigest: digest as `0x${string}` })).toBeNull();
  });

  /**
   * A row whose accuracy is a string survives verification, because `verifyRows` proves the
   * manifest and the identity — it does not police every measurement's type. So the join has to
   * refuse it itself, and this fixture writes the shape a sloppy or hostile producer would: a
   * number in quotes, which `verifyPublication` has no reason to reject.
   */
  it("refuses a row whose accuracy is not a number", async () => {
    const { digest, deps } = await publication({ rawAccuracy: "0.5" });
    // The publication still verifies — that is the premise, and without it this test would be
    // proving the wrong guard fired.
    const entries = await buildScorecardIndex(deps);
    expect(entries.size).toBe(0);
    const ranking = await createScorecardRanking(deps);
    expect(ranking({ agentId, manifestDigest: digest as `0x${string}` })).toBeNull();
  });

  /**
   * Ambiguity is not resolved by whichever file was read last.
   *
   * Two cohorts claiming the same (agent, manifest) means somebody's cohort name does not mean
   * what it says. Picking by `issuedAt` would be a comparability decision that no signature made,
   * so the key is poisoned and neither cohort gets a rankable row.
   *
   * Both publications are written into ONE host — one store, one publications directory. The first
   * draft concatenated two separate fixtures and stayed green with the poisoning deleted, because
   * publication B's scorecard bytes were not in store A, so the whole read faulted before the
   * collision was ever reached. A test that passes because the data could not be found is not a
   * test of ambiguity.
   */
  it("poisons the key when two cohorts claim the same agent and manifest", async () => {
    const both = await publicationPair();
    // Premise, asserted rather than assumed: the collision was reached, not skipped past. One key,
    // and its value is the "unresolvable" marker rather than either cohort.
    const entries = await buildScorecardIndex(both.deps);
    expect(entries.size).toBe(1);
    expect([...entries.values()]).toEqual([null]);

    const ranking = await createScorecardRanking(both.deps);
    expect(ranking({ agentId, manifestDigest: both.digest as `0x${string}` })).toBeNull();
  });

  it("yields nothing when this host authorises no signers at all", async () => {
    const { digest, deps } = await publication();
    const ranking = await createScorecardRanking({ ...deps, signers: [] });
    expect(ranking({ agentId, manifestDigest: digest as `0x${string}` })).toBeNull();
  });

  /**
   * A publication this host would answer 500 about cannot contribute a row.
   *
   * The failure is reported (the callback below it stays empty and the fault is handed to
   * `reportFault`) rather than thrown out of a booting process — one damaged file must not take
   * down every route that has nothing to do with scores, and it must not score silently either.
   */
  it("disables scoring and says why when a stored publication fails verification", async () => {
    const { digest, deps } = await publication({ invalidSignature: true });
    const faults: string[] = [];
    const ranking = await createScorecardRanking(deps, (message) => faults.push(message));
    expect(ranking({ agentId, manifestDigest: digest as `0x${string}` })).toBeNull();
    expect(faults).toHaveLength(1);
    expect(faults[0]!.toLowerCase()).toContain("signature");
  });

  it("scores nothing for a signer this host has not authorised", async () => {
    const { digest, deps } = await publication({ untrustedSigner: true });
    const faults: string[] = [];
    const ranking = await createScorecardRanking(deps, (m) => faults.push(m));
    expect(ranking({ agentId, manifestDigest: digest as `0x${string}` })).toBeNull();
    expect(faults.join(" ")).toContain("signer");
  });
});
