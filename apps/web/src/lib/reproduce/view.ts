/**
 * The reproduction view's rules, kept out of the page.
 *
 * Same division `lib/replay/view.ts` makes: the page fetches, holds the response and says what it
 * is waiting for; everything about *how a fact is allowed to look* lives here, where it can be
 * tested without a browser. That distinction is the whole reason this file exists — a rule about
 * how an unknown value renders is worth nothing if the only way to check it is to look at a
 * running page and hope the row is empty.
 */

export interface ReproduceStep {
  name: string;
  passed: boolean;
  detail: Record<string, unknown>;
  failure?: string;
}

export interface Reproduction {
  trialId: number;
  reproduced: boolean;
  steps: ReproduceStep[];
  chain: Record<string, unknown>;
}

/** What each binding is, in the visitor's words rather than the code's. */
export const STEP_COPY: Record<string, { title: string; asking: string }> = {
  disclosure: {
    title: "The runner published the bytes",
    asking: "Did anybody announce what this run hash is supposed to be?",
  },
  "artifact-hash": {
    title: "The bytes hash to what the chain recorded",
    asking: "Hash the artifact the way the contract does and compare it to the run hash on-chain.",
  },
  signature: {
    title: "The signature recovers to the registered key",
    asking: "Rebuild the message the agent signed and see which address it comes from.",
  },
  manifest: {
    title: "The evaluation manifest matches its announced digest",
    asking: "The conditions the score was produced under, checked against the number quoted for them.",
  },
  report: {
    title: "A verification report exists for this run",
    asking: "What the committee's verifier concluded, and which build of it said so.",
  },
};

/**
 * Fields worth printing, and what to call them.
 *
 * A field the API starts returning without a label here is *not shown* rather than shown as its
 * key — the list is a decision about what a visitor should read, not a dump of a payload. That is
 * also why `reproduce-view.test.ts` asserts the route's own step names are all covered here: a
 * new binding arriving with no copy would render its raw slug as a heading.
 */
export const DETAIL_LABELS: Record<string, string> = {
  artifactCid: "artifact",
  manifestCid: "manifest",
  reportCid: "report",
  reportVersion: "report version",
  reportDigest: "report digest",
  chainRunHash: "run hash on-chain",
  recomputedRunHash: "recomputed from bytes",
  recoveredSigner: "signed by",
  registeredRunner: "registered key",
  announcedDigest: "announced digest",
  recomputedDigest: "recomputed digest",
  suiteDigest: "suite",
  evaluatorVersion: "evaluator",
  verifiedAt: "verified at",
  sigDeadline: "signature deadline",
  claimedTests: "tests claimed",
  claimedPassed: "passed claimed",
  claimedRunner: "artifact names",
  verdict: "verdict",
  phase: "phase",
  digest: "signed digest",
  runHash: "run hash",
};

/**
 * One value, as the page says it.
 *
 * Unknown is an em dash and never a zero, and booleans become words because `true` under a label
 * like "tests claimed" reads as a count. This is the rule `clock.ts`, `ops.ts` and `api.ts` all
 * enforce for money and time; a reproduction is the same kind of claim and gets the same treatment.
 */
export function shown(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The tone a step's own result selects — and only those two, so no state invents a colour. */
export function toneFor(passed: boolean): "quench" | "sear" {
  return passed ? "quench" : "sear";
}

/** A step whose name the page has never heard of still renders, with its slug as the heading. */
export function copyFor(name: string): { title: string; asking: string } {
  return STEP_COPY[name] ?? { title: name, asking: "" };
}

/** Only the labelled fields, in the API's own order. */
export function detailEntries(detail: Record<string, unknown>): [string, string, string][] {
  return Object.entries(detail)
    .filter(([key]) => key in DETAIL_LABELS)
    .map(([key, value]) => [DETAIL_LABELS[key]!, shown(value), key]);
}

/**
 * A shape check, not a second schema: the page must not become the place where a reproduction's
 * fields are defined all over again. Anything that is not a reproduction is an unreadable answer,
 * said out loud, rather than a half-rendered list of bindings.
 */
export function asReproduction(body: unknown): Reproduction | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.trialId !== "number" || typeof candidate.reproduced !== "boolean") return null;
  if (!Array.isArray(candidate.steps) || !candidate.steps.every(isStep)) return null;
  if (typeof candidate.chain !== "object" || candidate.chain === null) return null;
  return {
    trialId: candidate.trialId,
    reproduced: candidate.reproduced,
    steps: candidate.steps,
    chain: candidate.chain as Record<string, unknown>,
  };
}

function isStep(value: unknown): value is ReproduceStep {
  if (typeof value !== "object" || value === null) return false;
  const step = value as Record<string, unknown>;
  return (
    typeof step.name === "string" &&
    typeof step.passed === "boolean" &&
    typeof step.detail === "object" &&
    step.detail !== null &&
    (step.failure === undefined || typeof step.failure === "string")
  );
}
