import { ContentBridge } from "@crucible/cidstore";
import { digestOfContent } from "@crucible/smith";

/**
 * The content layer, for the side that produces work.
 *
 * Until now every one of these functions existed only as a test fake, which meant the
 * `specCID` / `testsCID` / `repoCID` inside a run artifact were digests of bytes that were
 * never stored anywhere — so a verifier could not fetch what it was being asked to check,
 * and the deterministic re-run the design calls the oracle could not execute.
 *
 * The rule this file exists to honour: **pin before you post.** A chain commitment is
 * keccak over the content bytes, so the content has to exist and be announced before the
 * trial is created — a digest computed over something unpinnable (for instance one mixed
 * with `block.timestamp`) can never be resolved afterwards, by anyone, for any reason.
 */

/** A run artifact or a test tree, as bytes in the store. */
export interface FileTree {
  files: Record<string, string>;
}

/**
 * The part of `Sandbox` this service touches.
 *
 * Declared rather than imported so the seam is explicit: production passes a real
 * container, and a test that only wants to check what gets pinned can pass a directory
 * without building one. Everything here is a file read or a command; there is no behaviour
 * being stubbed.
 */
export interface TreeTarget {
  repoDir: string;
  runSuite(command: string, workDir?: string): Promise<{ stdout: string; code: number }>;
  writeFile(relative: string, contents: string): Promise<string>;
}

export interface ContentServiceOptions {
  bridge: ContentBridge;
  /** How many files a single listing may return. A pinned tree is not a whole filesystem. */
  maxTreeFiles?: number;
}

const DEFAULT_MAX_TREE_FILES = 200;

export class ContentService {
  private readonly maxFiles: number;

  constructor(private readonly opts: ContentServiceOptions) {
    this.maxFiles = opts.maxTreeFiles ?? DEFAULT_MAX_TREE_FILES;
  }

  /**
   * Pin spec or suite text and hand back the digest the sponsor must put on-chain.
   *
   * This is the ordering rule made concrete: call this first, post the trial with the
   * digest it returns, and a verifier can always get the bytes back.
   */
  async pinText(text: string): Promise<{ cid: string; digest: string }> {
    const pinned = await this.opts.bridge.pinContent(text);
    return { cid: pinned.cid, digest: pinned.digest };
  }

  /** Pin a whole test tree so a trial can commit to its digest. */
  async pinSuite(tree: FileTree): Promise<{ cid: string; digest: string; files: number }> {
    const pinned = await this.opts.bridge.pinContent(JSON.stringify(tree));
    return { cid: pinned.cid, digest: pinned.digest, files: Object.keys(tree.files).length };
  }

  /**
   * Resolve a trial's on-chain digest back to the sponsor's text.
   *
   * Throws when nothing was ever announced for the digest. That is not a nuisance
   * answer: it is the difference between "the content is unavailable" and "this trial was
   * posted with a digest that never had content", and only the second one is a design fault.
   */
  async fetchTextByDigest(digest: string): Promise<string> {
    return this.opts.bridge.contentForDigest(digest);
  }

  /** The runner's `fetchSpec`. A CID is accepted as well as a digest, for pinned specs. */
  async fetchSpec(cidOrDigest: string): Promise<string> {
    if (looksLikeDigest(cidOrDigest)) {
      return this.opts.bridge.contentForDigest(cidOrDigest);
    }
    const text = this.opts.bridge.textForCid(cidOrDigest);
    if (text === null) throw new Error(`no content is stored for ${cidOrDigest}`);
    return text;
  }

  /**
   * The runner's `fetchSuite`: materialise the pinned tree into the bench.
   *
   * Returns a 40-hex digest of the suite bytes in place of a git commit sha. It is not a
   * commit — the bench is unpacked from the store, not cloned — and naming it as one would
   * put a number in the artifact that no repository answers to. Whatever reads it can
   * recompute it from the same bytes.
   */
  async fetchSuite(cidOrDigest: string, target: TreeTarget): Promise<string> {
    const text = await this.fetchContent(cidOrDigest);
    const tree = parseTree(text, cidOrDigest);
    const names = Object.keys(tree.files).sort();
    if (names.length === 0) {
      throw new Error(`the pinned suite ${cidOrDigest} holds no files`);
    }
    for (const name of names) {
      assertSafeRelative(name, cidOrDigest);
      await target.writeFile(name, tree.files[name]!);
    }
    return suiteDigest(names.map((n) => `${n}\n${tree.files[n]}\n`).join(""));
  }

  /**
   * The runner's `uploadRepo`: pin what is in the bench now.
   *
   * Listing is one command, then one read per file, capped. The cap is not politeness — a
   * runaway agent that wrote a thousand files would otherwise be pinned into a single entry
   * the store refuses, after the work had already been wasted.
   */
  async uploadRepo(target: TreeTarget): Promise<string> {
    const listing = await target.runSuite(
      "find . -type f -not -path './.git/*' | sed 's|^\\./||' | sort",
      target.repoDir,
    );
    if (listing.code !== 0) {
      throw new Error(`could not list the bench (${listing.stdout.slice(0, 200)})`);
    }
    const names = listing.stdout.split("\n").map((n) => n.trim()).filter(Boolean).slice(0, this.maxFiles);
    if (!names.length) throw new Error("the bench holds no files to pin");
    const files: Record<string, string> = {};
    for (const name of names) {
      const read = await target.runSuite(`base64 -w0 "${name}"`, target.repoDir);
      if (read.code !== 0) throw new Error(`could not read ${name} out of the bench`);
      files[name] = Buffer.from(read.stdout.trim(), "base64").toString("utf8");
    }
    const pinned = await this.opts.bridge.pinContent(JSON.stringify({ files } satisfies FileTree));
    return pinned.cid;
  }

  /** The runner's `uploadLogs`. */
  async uploadLogs(contents: string): Promise<string> {
    return (await this.opts.bridge.pinContent(contents)).cid;
  }

  /**
   * Publish a run so it can be verified later, including the two values the chain throws
   * away. Without this, `submitRun`'s signature is unrecoverable to any later reader and
   * verification step 5 cannot be performed by anyone but the submitter.
   */
  async publishArtifact(
    artifact: unknown,
    runHash: string,
    signature: string,
    sigDeadline: string,
  ): Promise<string> {
    const pinned = await this.opts.bridge.pinArtifact(artifact, { runHash, signature, sigDeadline });
    return pinned.cid;
  }

  /** Read a run artifact back by cid, with the cid owning its bytes. */
  async readArtifact<T>(cid: string): Promise<T> {
    return this.opts.bridge.artifactForCid<T>(cid);
  }

  /** The announcement for a run hash: where the artifact is, and what the chain discarded. */
  async recordForRun(runHash: string) {
    return this.opts.bridge.artifactRecord(runHash);
  }

  private async fetchContent(cidOrDigest: string): Promise<string> {
    return this.fetchSpec(cidOrDigest);
  }
}

function looksLikeDigest(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function parseTree(text: string, forCid: string): FileTree {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`the pinned tree ${forCid} is not JSON (${(err as Error).message})`);
  }
  const files = (parsed as Partial<FileTree>)?.files;
  if (!files || typeof files !== "object") {
    throw new Error(`the pinned tree ${forCid} has no "files" map`);
  }
  return { files: files as Record<string, string> };
}

/**
 * Refuses a suite file that would land outside the bench.
 *
 * The pinned tree is chosen by the sponsor, and a sponsor is not automatically honest. An
 * entry named `../../etc/passwd` would otherwise be written by the runner's own tool into
 * whatever sandbox it is standing in — the pinning is trusted, the paths in it are not.
 */
function assertSafeRelative(name: string, forCid: string): void {
  if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
    throw new Error(`the pinned tree ${forCid} contains an unsafe path: "${name}"`);
  }
}

/** 40 hex, so it fits the field a git sha was expected in, and it is recomputable. */
function suiteDigest(concatenated: string): string {
  return digestOfContent(concatenated).slice(0, 42);
}
