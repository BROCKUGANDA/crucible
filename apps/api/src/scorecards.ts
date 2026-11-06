import { Hono } from "hono";
import {
  digestOfContent,
  isScorecardCohort,
  manifestDigest,
  scorecardPublicationId,
  scorecardTypedData,
  type EvalManifest,
  type ScorecardPublication,
} from "@crucible/smith";
import { isCid } from "@crucible/cidstore";
import { isAddress, isHex, verifyTypedData, type Address, type Hex } from "viem";
import type { ReadModel } from "@crucible/indexer";
import type { ContentLookup, ContentRead } from "./content.js";

export interface StoredScorecardPublication {
  fileId: string;
  value: unknown;
}

export type ScorecardPublicationSource = () => readonly StoredScorecardPublication[];

interface ScorecardRouteDeps {
  getModel: () => ReadModel;
  contentLookup?: ContentLookup;
  proofSource?: { chain: string; chainId: number; trialsAddress: string };
  publications?: ScorecardPublicationSource;
  signers?: readonly string[];
}

interface VerifiedScorecard {
  publication: ScorecardPublication;
  scorecard: Record<string, unknown>;
}

class PublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function digestText(text: string): Hex {
  return digestOfContent(text) as Hex;
}

function readText(lookup: ContentLookup, cid: string, label: string): string {
  let read: ContentRead;
  try {
    read = lookup(cid);
  } catch (error) {
    throw new PublicationError(`${label} could not be read from the content store`);
  }
  if (read.kind === "text") return read.text;
  if (read.kind === "bytes") throw new PublicationError(`${label} is not UTF-8 JSON text`);
  throw new PublicationError(`${label} is unavailable from this host (${read.kind})`);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PublicationError(`${label} is not valid JSON`);
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function verifyRows(scorecard: Record<string, unknown>): void {
  if (!Array.isArray(scorecard.rows) || scorecard.rows.length === 0) {
    throw new PublicationError("scorecard has no evaluation rows");
  }
  const seen = new Set<string>();
  for (const candidate of scorecard.rows) {
    if (!object(candidate)) {
      throw new PublicationError("scorecard row has no manifest");
    }
    const row = candidate;
    const manifestValue = row.manifest;
    if (!object(manifestValue)) {
      throw new PublicationError("scorecard row has no manifest");
    }
    if (typeof row.modelId !== "string" || typeof row.suite !== "string") {
      throw new PublicationError("scorecard row is missing its model or suite identity");
    }
    const rowKey = `${row.modelId}\u0000${row.suite}`;
    if (seen.has(rowKey)) throw new PublicationError("scorecard contains duplicate model and suite rows");
    seen.add(rowKey);
    const manifest = manifestValue as unknown as EvalManifest;
    let computed: string;
    try {
      computed = manifestDigest(manifest).toLowerCase();
    } catch {
      throw new PublicationError(`manifest for ${row.modelId}/${row.suite} cannot be canonicalized`);
    }
    if (typeof row.manifestDigest !== "string" || computed !== row.manifestDigest.toLowerCase()) {
      throw new PublicationError(`manifest digest mismatch for ${row.modelId}/${row.suite}`);
    }
    if (
      !object(manifestValue.model) ||
      manifestValue.model.name !== row.modelId ||
      manifestValue.suiteDigest !== row.suiteEpoch
    ) {
      throw new PublicationError(`manifest identity mismatch for ${row.modelId}/${row.suite}`);
    }
  }
}

function verifyEvidence(lookup: ContentLookup, scorecard: Record<string, unknown>): void {
  const corpusRef = scorecard.corpusEvidence;
  if (!object(corpusRef) || typeof corpusRef.cid !== "string" || typeof corpusRef.digest !== "string") {
    throw new PublicationError("scorecard has no corpus evidence reference");
  }
  if (!isCid(corpusRef.cid)) throw new PublicationError("scorecard corpus reference is not a CID");
  const corpusText = readText(lookup, corpusRef.cid, "scorecard corpus evidence");
  if (digestText(corpusText).toLowerCase() !== corpusRef.digest.toLowerCase()) {
    throw new PublicationError("scorecard corpus evidence digest mismatch");
  }
  const corpus = parseJson(corpusText, "scorecard corpus evidence");
  if (!Array.isArray(corpus)) throw new PublicationError("scorecard corpus evidence is not an array");
  if (!object(scorecard.corpus) || scorecard.corpus.artifacts !== corpus.length) {
    throw new PublicationError("scorecard corpus count does not match its evidence");
  }
  const artifacts = new Map<string, unknown>();
  for (const artifact of corpus) {
    if (!object(artifact) || typeof artifact.claimHash !== "string" || artifacts.has(artifact.claimHash)) {
      throw new PublicationError("scorecard corpus evidence has an invalid or duplicate claim");
    }
    artifacts.set(artifact.claimHash, artifact.payload);
  }

  if (!Array.isArray(scorecard.trajectories)) {
    throw new PublicationError("scorecard trajectories are missing");
  }
  const seen = new Set<string>();
  for (const candidate of scorecard.trajectories) {
    if (!object(candidate) || typeof candidate.claimHash !== "string") {
      throw new PublicationError("scorecard trajectory is missing its evidence reference");
    }
    const row = candidate;
    const claimHash = row.claimHash as string;
    const refValue = row.evidence;
    if (!object(refValue)) throw new PublicationError("scorecard trajectory is missing its evidence reference");
    const ref = refValue;
    if (typeof ref.cid !== "string" || !isCid(ref.cid) || typeof ref.digest !== "string") {
      throw new PublicationError("scorecard trajectory has an invalid evidence reference");
    }
    const key = `${String(row.modelId)}\u0000${String(row.suite)}\u0000${claimHash}`;
    if (seen.has(key)) throw new PublicationError("scorecard contains duplicate trajectory evidence");
    seen.add(key);
    const evidenceText = readText(lookup, ref.cid, "trajectory evidence");
    if (digestText(evidenceText).toLowerCase() !== ref.digest.toLowerCase()) {
      throw new PublicationError(`trajectory evidence digest mismatch for ${claimHash}`);
    }
    const payload = parseJson(evidenceText, "trajectory evidence");
    if (!sameJson(payload, row.payload) || !sameJson(payload, artifacts.get(claimHash))) {
      throw new PublicationError(`trajectory payload does not match corpus evidence for ${claimHash}`);
    }
    const scorecardRows = scorecard.rows;
    if (!Array.isArray(scorecardRows)) throw new PublicationError("scorecard rows are missing");
    const matchingRow = scorecardRows.find(
      (item: unknown) => object(item) && item.modelId === row.modelId && item.suite === row.suite,
    );
    if (!object(matchingRow)) {
      throw new PublicationError(`trajectory ${claimHash} is not named by a scorecard row`);
    }
    const abstention = matchingRow.abstention;
    if (!object(abstention) || !Array.isArray(abstention.failures)) {
      throw new PublicationError(`trajectory ${claimHash} is not named by its scorecard row`);
    }
    if (!abstention.failures.some((failure: unknown) => object(failure) && failure.claimHash === claimHash)) {
      throw new PublicationError(`trajectory ${claimHash} is not named by its scorecard row`);
    }
  }
}

async function verifyPublication(
  stored: StoredScorecardPublication,
  deps: Required<Pick<ScorecardRouteDeps, "contentLookup" | "proofSource" | "signers">> &
    Pick<ScorecardRouteDeps, "getModel">,
): Promise<VerifiedScorecard> {
  if (!object(stored.value)) throw new PublicationError("publication envelope is not an object");
  const value = stored.value;
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.id) ||
    typeof value.signer !== "string" || !isAddress(value.signer, { strict: false }) ||
    typeof value.signature !== "string" || !isHex(value.signature, { strict: true }) ||
    !object(value.message)
  ) {
    throw new PublicationError("publication envelope fields are malformed");
  }
  const message = value.message;
  if (
    !isScorecardCohort(message.cohort) ||
    !Number.isSafeInteger(message.chainId) ||
    !Number.isSafeInteger(message.agentId) || (message.agentId as number) < 1 ||
    typeof message.runner !== "string" || !isAddress(message.runner, { strict: false }) ||
    typeof message.scorecardCid !== "string" || !isCid(message.scorecardCid) ||
    typeof message.scorecardDigest !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(message.scorecardDigest) ||
    !Number.isSafeInteger(message.issuedAt) || (message.issuedAt as number) < 1
  ) {
    throw new PublicationError("publication message fields are malformed");
  }
  if (message.chainId !== deps.proofSource.chainId) {
    throw new PublicationError("publication chain does not match this API host");
  }
  const computedId = scorecardPublicationId(message as unknown as ScorecardPublication["message"]);
  if (computedId.toLowerCase() !== value.id.toLowerCase() || stored.fileId.toLowerCase() !== computedId.slice(2).toLowerCase()) {
    throw new PublicationError("publication id does not match its file and signed message");
  }
  const trusted = deps.signers.some((signer) => sameAddress(signer, value.signer as string));
  if (!trusted) throw new PublicationError("publication signer is not authorized by this API host");
  let signatureValid = false;
  try {
    signatureValid = await verifyTypedData({
      address: value.signer as Address,
      ...scorecardTypedData(message as unknown as ScorecardPublication["message"]),
      signature: value.signature as Hex,
    });
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw new PublicationError("publication signature is invalid");

  const agent = deps.getModel().agents.get(message.agentId as number);
  if (!agent || !sameAddress(agent.runner, message.runner as string)) {
    throw new PublicationError("publication runner does not match the registered agent identity");
  }

  const publication = value as unknown as ScorecardPublication;
  const scorecardText = readText(deps.contentLookup, message.scorecardCid as string, "scorecard");
  if (digestText(scorecardText).toLowerCase() !== (message.scorecardDigest as string).toLowerCase()) {
    throw new PublicationError("scorecard digest does not match the pinned bytes");
  }
  const parsed = parseJson(scorecardText, "scorecard");
  if (!object(parsed) || parsed.kind !== "crucible/arena-scorecard" || parsed.version !== 1) {
    throw new PublicationError("scorecard artifact has an unsupported shape");
  }
  const subject = parsed.publication;
  if (
    !object(subject) ||
    subject.cohort !== message.cohort || subject.chainId !== message.chainId ||
    subject.agentId !== message.agentId || !sameAddress(String(subject.runner ?? ""), message.runner as string) ||
    subject.issuedAt !== message.issuedAt || !sameAddress(String(subject.signer ?? ""), value.signer as string)
  ) {
    throw new PublicationError("scorecard subject does not match its signed publication");
  }
  verifyRows(parsed);
  verifyEvidence(deps.contentLookup, parsed);
  return { publication, scorecard: parsed };
}

export function scorecardRoutes(deps: ScorecardRouteDeps): Hono {
  const app = new Hono();

  app.get("/content/:cid", (c) => {
    const cid = c.req.param("cid");
    if (!deps.contentLookup) return c.json({ error: "Scorecard content is not configured" }, 503);
    if (!isCid(cid)) return c.json({ error: "A content id is required" }, 400);
    const read = deps.contentLookup(cid);
    const headers = { "cache-control": "public, max-age=31536000, immutable" };
    if (read.kind === "text") {
      return c.body(read.text, 200, { ...headers, "content-type": "text/plain; charset=utf-8" });
    }
    if (read.kind === "bytes") {
      return new Response(read.bytes, { status: 200, headers: { ...headers, "content-type": "application/octet-stream" } });
    }
    if (read.kind === "unreadable") return c.json({ error: "Scorecard content could not be read" }, 503);
    if (read.kind === "corrupt") return c.json({ error: "Scorecard content failed its content id check" }, 500);
    return c.json({ error: "Scorecard content is not stored on this host" }, 404);
  });

  const readVerified = async () => {
    if (!deps.publications || !deps.contentLookup || !deps.proofSource || !deps.signers?.length) {
      return { error: "Scorecard publication verification is not configured" as const };
    }
    const raw = deps.publications();
    const ids = new Set<string>();
    const verified: VerifiedScorecard[] = [];
    for (const stored of raw) {
      const result = await verifyPublication(stored, {
        getModel: deps.getModel,
        contentLookup: deps.contentLookup,
        proofSource: deps.proofSource,
        signers: deps.signers,
      });
      const id = result.publication.id.toLowerCase();
      if (ids.has(id)) throw new PublicationError("publication replay appears more than once in the store");
      ids.add(id);
      verified.push(result);
    }
    return { verified };
  };

  app.get("/", async (c) => {
    const cohort = c.req.query("cohort");
    if (cohort !== undefined && !isScorecardCohort(cohort)) {
      return c.json({ error: "cohort must be 1 to 64 plain letters, numbers, dots, underscores, colons or hyphens" }, 400);
    }
    const rawAgentId = c.req.query("agentId");
    let agentId: number | undefined;
    if (rawAgentId !== undefined) {
      if (!/^\d+$/.test(rawAgentId) || !Number.isSafeInteger(Number(rawAgentId)) || Number(rawAgentId) < 1) {
        return c.json({ error: "agentId must be a positive whole number" }, 400);
      }
      agentId = Number(rawAgentId);
    }
    try {
      const result = await readVerified();
      if ("error" in result) return c.json({ error: result.error }, 503);
      const cohorts = [...new Set(result.verified.map((entry) => entry.publication.message.cohort))].sort();
      const publications = result.verified
        .filter((entry) => cohort === undefined || entry.publication.message.cohort === cohort)
        .filter((entry) => agentId === undefined || entry.publication.message.agentId === agentId)
        .map((entry) => ({ ...entry.publication, scorecard: entry.scorecard }));
      return c.json({ configured: true, count: publications.length, cohorts, publications });
    } catch (error) {
      const reason = error instanceof PublicationError ? error.message : "publication source could not be read";
      return c.json({ error: "A stored scorecard failed verification", reason }, 500);
    }
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id").toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(id)) return c.json({ error: "scorecard publication id must be a 32-byte hash" }, 400);
    try {
      const result = await readVerified();
      if ("error" in result) return c.json({ error: result.error }, 503);
      const found = result.verified.find((entry) => entry.publication.id.slice(2).toLowerCase() === id);
      if (!found) return c.json({ error: "No verified scorecard publication has that id" }, 404);
      return c.json({ ...found.publication, scorecard: found.scorecard });
    } catch (error) {
      const reason = error instanceof PublicationError ? error.message : "publication source could not be read";
      return c.json({ error: "A stored scorecard failed verification", reason }, 500);
    }
  });

  return app;
}
