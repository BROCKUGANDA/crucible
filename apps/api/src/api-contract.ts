/**
 * @file api-contract.ts — the API's contract, described by the API.
 *
 * A developer portal that documents the API in prose drifts from the API
 * the first time somebody renames an error code. There are three ways to
 * stop that, and this file takes the cheapest honest one: the catalogue
 * below is the SAME list the routes emit from, and a test reads the routes'
 * source and fails if a code appears there without an entry here.
 *
 * So the error catalogue cannot rot, the rate limit cannot be described
 * wrongly, and the pagination rules cannot be described wrongly — they are
 * read from the modules that enforce them.
 *
 * The endpoint that serves this is `GET /v1/contract`. It is public, it is
 * read-only, and it is the thing the developer portal renders.
 */

import { MAX_PAGE } from "./pagination.js";

/** The API's version prefix. Everything versioned lives under it. */
export const API_VERSION = "v1";

/**
 * The sustained rate, the window and the burst.
 *
 * These are the numbers `app.ts` applies to every route by default. They
 * live here so the portal and the limiter cannot disagree; a drift test
 * asserts that this object is the one the app installs.
 */
export const DEFAULT_RATE_LIMIT = { limit: 60, windowMs: 60_000, burst: 20 } as const;

/** What one error code means and what a caller should do about it. */
export interface ErrorCodeEntry {
  /** The `code` field in the JSON body. */
  code: string;
  /** The HTTP status this code normally carries. */
  status: number;
  /** What happened, in one sentence. */
  meaning: string;
  /** What the caller can do. */
  whatToDo: string;
}

/**
 * Every error code the API emits.
 *
 * Kept in one place, and enforced: `test/api-contract.test.ts` reads the
 * routes' source and fails when a `code:` appears there without an entry
 * here. Adding a code to a route without documenting it is a failing test,
 * not an omission.
 */
export const ERROR_CATALOGUE: ErrorCodeEntry[] = [
  {
    code: "bad-request",
    status: 400,
    meaning: "The request was understood and refused: a field is missing, malformed, or out of range.",
    whatToDo: "Read the `error` field: it names the field. Fix it and send it again.",
  },
  {
    code: "no-such-case",
    status: 404,
    meaning: "The review queue was asked for a case that does not exist: no trial carries that id.",
    whatToDo: "Read the queue and take an id from it. A trial id is the chain's own number.",
  },
  {
    code: "case-closed",
    status: 403,
    meaning: "The trial is settled, so there is nothing left to review: the chain has already decided it.",
    whatToDo: "Read the trial's own page. A settled trial's verdict is a fact, not an open question.",
  },
  {
    code: "conflicted",
    status: 403,
    meaning:
      "The reviewer has a recorded conflict of interest with the trial's sponsor, so the platform refuses " +
      "the case to them.",
    whatToDo:
      "Do not dispute the refusal. A conflict that is merely displayed is one a reviewer in a hurry ignores; " +
      "another reviewer without the conflict may take the case.",
  },
  {
    code: "abstained",
    status: 403,
    meaning: "The reviewer already stepped away from this case, so the platform will not hand it back.",
    whatToDo: "Read the abstention reason on the queue page. It is the reviewer's own words.",
  },
  {
    code: "already-yours",
    status: 403,
    meaning: "The reviewer already holds this case. A hold is not re-taken; it is released by stepping away.",
    whatToDo: "Read the sealed evidence for the case. To hand it back, step away from it with a reason.",
  },
  {
    code: "already-held",
    status: 403,
    meaning: "Another reviewer holds this case; a case is held by one reviewer at a time.",
    whatToDo: "Take another case from the queue, or wait for the holder to step away from it.",
  },
  {
    code: "no-credential",
    status: 401,
    meaning: "The request carried no credential the server accepts.",
    whatToDo: "Sign in first. A wallet signature (SIWE) is the usual credential; an organisation API key is the other.",
  },
  {
    code: "csrf-origin",
    status: 403,
    meaning: "A state-changing request arrived without a matching Origin header.",
    whatToDo: "Send the request from a browser page on the same origin, or use an API key, which is not subject to the origin check.",
  },
  {
    code: "forbidden",
    status: 403,
    meaning: "The credential is valid but not allowed to do this.",
    whatToDo: "Ask for the scope you need. Each organisation role grants a different set.",
  },
  {
    code: "revoked",
    status: 401,
    meaning: "The API key that was presented has been revoked. A revocation survives a restart.",
    whatToDo: "Make another key in the organisation's console and use that. The old one will not come back.",
  },
  {
    code: "expired",
    status: 401,
    meaning: "The API key that was presented has expired.",
    whatToDo: "Make another key in the organisation's console. An expired key is not extended.",
  },
  {
    code: "wrong-scope",
    status: 403,
    meaning:
      "The API key that was presented does not carry the scope the request needs, or the secret did not match.",
    whatToDo: "Read the key's scopes in the organisation's console and ask for one that carries what you need.",
  },
  {
    code: "key-not-for-this-org",
    status: 403,
    meaning: "The API key that was presented belongs to another organisation, so it cannot read this one.",
    whatToDo:
      "Use the key of the organisation whose record you are reading. A key that reads another organisation would " +
      "be a key with the wrong grant, not a key with a missing check.",
  },
  {
    code: "not-a-member",
    status: 403,
    meaning: "The caller is not a member of the organisation named in the request.",
    whatToDo: "Ask the organisation to invite the address, or use the organisation you are a member of.",
  },
  {
    code: "not-a-worker",
    status: 403,
    meaning: "The request may only come from the worker that owns the queue.",
    whatToDo: "This route is not for clients. Workers authenticate with the worker's own credential.",
  },
  {
    code: "not-your-entitlements",
    status: 403,
    meaning: "The credential is not the one that owns these resources.",
    whatToDo: "Use the credential the resources were created with.",
  },
  {
    code: "not-found",
    status: 404,
    meaning: "Nothing is stored under that id.",
    whatToDo: "Check the id. The API does not distinguish 'never existed' from 'deleted'.",
  },
  {
    code: "not_found",
    status: 404,
    meaning: "Nothing is stored under that id, using the older underscore spelling of the code.",
    whatToDo: "Check the id. This spelling is used by the older routes; it means the same as not-found.",
  },
  {
    code: "not-sponsor",
    status: 403,
    meaning: "Only the sponsor of this trial may act on it.",
    whatToDo: "Ask the sponsor, or act on a trial you sponsor.",
  },
  {
    code: "not_eligible",
    status: 404,
    meaning: "The campaign exists and the caller does not qualify for it.",
    whatToDo: "Read the campaign's eligibility rules.",
  },
  {
    code: "campaign_not_active",
    status: 409,
    meaning: "The campaign is not accepting anything right now.",
    whatToDo: "Read the campaign's status and its start and end times.",
  },
  {
    code: "claim_window_not_open",
    status: 409,
    meaning: "The campaign's claim window has not opened yet.",
    whatToDo: "Wait for the window, or read the campaign's schedule.",
  },
  {
    code: "claim_window_closed",
    status: 409,
    meaning: "The campaign's claim window has closed.",
    whatToDo: "The window is past; claims are no longer accepted.",
  },
  {
    code: "max_claims_reached",
    status: 409,
    meaning: "The campaign has claimed its full allowance.",
    whatToDo: "Read the campaign's claim limit.",
  },
  {
    code: "budget_exceeded",
    status: 409,
    meaning: "The claim would take the campaign past its budget.",
    whatToDo: "Lower the amount, or wait for the budget to be topped up.",
  },
  {
    code: "budget_depleted",
    status: 409,
    meaning: "The campaign's budget is spent.",
    whatToDo: "Top the campaign up, or start another one.",
  },
  {
    code: "no-such-org",
    status: 404,
    meaning: "No organisation is stored under that id.",
    whatToDo: "Check the organisation id.",
  },
  {
    code: "not-such-org",
    status: 404,
    meaning: "No organisation is stored under that id, using the hyphenated spelling of the code.",
    whatToDo: "Check the organisation id. This spelling is used by the organisation routes.",
  },
  {
    code: "no-such-key",
    status: 404,
    meaning: "No API key is stored under that id, or it has been revoked.",
    whatToDo: "Issue a new key. Revoked keys stay revoked.",
  },
  {
    code: "not-eligible",
    status: 404,
    meaning: "The resource exists but the caller is not eligible for it.",
    whatToDo: "Check the eligibility rules on the programme or suite.",
  },
  {
    code: "conflict",
    status: 409,
    meaning: "The request collides with the state of the resource.",
    whatToDo: "Read the current state and decide whether to transition or to leave it alone.",
  },
  {
    code: "invalid-transition",
    status: 409,
    meaning: "The resource cannot move to that state from the state it is in.",
    whatToDo: "Read the state machine in the docs; only the listed transitions are legal.",
  },
  {
    code: "run-immutable-field",
    status: 409,
    meaning: "A published run cannot be edited.",
    whatToDo: "Create a new run instead. Published runs are immutable by design.",
  },
  {
    code: "claim_not_pending",
    status: 409,
    meaning: "The claim has already been settled or withdrawn.",
    whatToDo: "Read the claim's state before acting on it.",
  },
  {
    code: "claim_not_found",
    status: 404,
    meaning: "No claim is stored under that id.",
    whatToDo: "Check the claim id.",
  },
  {
    code: "campaign_not_found",
    status: 404,
    meaning: "No campaign is stored under that id.",
    whatToDo: "Check the campaign id.",
  },
  {
    code: "terminal-state",
    status: 409,
    meaning: "The resource has reached a state it cannot leave.",
    whatToDo: "Nothing to do — this is the end of the line for that resource.",
  },
  {
    code: "not-published",
    status: 400,
    meaning: "Only published suite versions can be used.",
    whatToDo: "Publish the version, or use a published one.",
  },
  {
    code: "not-implemented",
    status: 501,
    meaning: "This route is not implemented in this deployment.",
    whatToDo: "Check the deployment's enabled features.",
  },
  {
    code: "not-authenticated",
    status: 401,
    meaning: "The credential was absent or could not be verified.",
    whatToDo: "Sign in again; the session may have expired.",
  },
  {
    code: "provider_error",
    status: 502,
    meaning: "An upstream provider failed on the API's behalf.",
    whatToDo: "Retry with backoff. The API did not complete the action; do not assume it did.",
  },
  {
    code: "failed",
    status: 500,
    meaning: "The request failed inside the API.",
    whatToDo: "Retry. If it keeps failing, the API's own log has the cause; the caller cannot see it.",
  },
  {
    code: "quota_exceeded",
    status: 429,
    meaning: "The tenant's usage limit for this period is used up.",
    whatToDo: "Wait for the period to reset, or raise the limit on the plan.",
  },
  {
    code: "stamp_disabled",
    status: 404,
    meaning: "STAMP is switched off on this host.",
    whatToDo: "Deploy with STAMP enabled, or use the fork path.",
  },
  {
    code: "stamp_wrong_cluster",
    status: 400,
    meaning: "The request names a cluster this host does not serve.",
    whatToDo: "Use the cluster the deployment published.",
  },
  {
    code: "stamp_no_binders",
    status: 403,
    meaning: "No binder is configured for this request.",
    whatToDo: "A binder is the key that signs a STAMP verdict. Ask the operator.",
  },
  {
    code: "stamp_invalid_transition",
    status: 409,
    meaning: "The STAMP item cannot move to that state from the state it is in.",
    whatToDo: "Read the item's state machine.",
  },
  {
    code: "stamp_delivery_duplicate",
    status: 409,
    meaning: "The same delivery was already accepted.",
    whatToDo: "Treat it as delivered. The API is idempotent for this route on purpose.",
  },
  {
    code: "stamp_client_verdict_refused",
    status: 400,
    meaning: "A client-supplied verdict was refused.",
    whatToDo: "Verdicts are signed by a binder, not asserted by the client.",
  },
  {
    code: "caller-supplied-verdict-refused",
    status: 400,
    meaning:
      "The caller tried to publish a score, a verdict, a status, the limits or the digest of a published method.",
    whatToDo:
      "Send only the subject (trialId or runId). A publication states what the platform measured; a caller that supplies the measurement is refused.",
  },
  {
    code: "caller-supplied-evidence-refused",
    status: 400,
    meaning:
      "The caller tried to supply the evidence, the gaps or the digest of a frozen dispute bundle.",
    whatToDo:
      "Send the trial id only. A bundle states what the platform saw; a caller that supplies the evidence is refused.",
  },
  {
    code: "no-such-bundle",
    status: 404,
    meaning: "No frozen bundle carries that address.",
    whatToDo:
      "A bundle is content-addressed: it exists under exactly one address. List the bundles of the trial instead.",
  },
  {
    code: "no-manifest",
    status: 404,
    meaning: "There is no replay manifest for that subject, so there is no method to publish.",
    whatToDo:
      "Run the evaluation first. A method exists only once a measurement has been recorded: the subject must have been run and its replay manifest written.",
  },
  {
    code: "no-such-publication",
    status: 404,
    meaning: "No published method carries that address.",
    whatToDo:
      "A published method is content-addressed: it exists under exactly one address. Check the id, or list the publications of the subject.",
  },
  {
    code: "no-chain",
    status: 503,
    meaning: "This deployment has no chain, so nothing on it can be read or verified.",
    whatToDo: "Deploy with a chain configured. A funding claim stays unchecked until then.",
  },
  {
    code: "stamp_sandbox_only",
    status: 403,
    meaning: "This route exists only in sandbox mode.",
    whatToDo: "STAMP's sandbox mode is for rehearsal. Production uses the signed path.",
  },
  {
    code: "stamp_manual_review_only",
    status: 403,
    meaning: "This host only accepts verdicts through manual review.",
    whatToDo: "Send a verdict to the review queue the operator published.",
  },
  {
    code: "stamp_production_blocked",
    status: 403,
    meaning: "Production STAMP is switched off on this host.",
    whatToDo: "The operator enables it; the checks it depends on are listed in the deployment record.",
  },
  {
    code: "stamp_address_unproved",
    status: 400,
    meaning: "The address behind the request has not been proved.",
    whatToDo: "Prove the address's ownership first; STAMP binds verdicts to proved addresses.",
  },
  {
    code: "stamp_holder_unbound",
    status: 403,
    meaning: "The holder is not bound to the holder set for this document.",
    whatToDo: "Bind the holder before resting an item against it.",
  },
  {
    code: "stamp_no_vesting",
    status: 409,
    meaning: "This document has no vesting schedule, so it cannot be rested against.",
    whatToDo: "Publish the vesting schedule with the document.",
  },
  {
    code: "stamp_vesting_mismatch",
    status: 409,
    meaning: "The vesting schedule on the document does not match the one published.",
    whatToDo: "Re-read the published schedule; the document may be a stale copy.",
  },
  {
    code: "stamp_wrong_mint",
    status: 400,
    meaning: "The document names a mint this host does not serve.",
    whatToDo: "Use the mint the deployment published.",
  },
  {
    code: "stamp_portion_unknown",
    status: 409,
    meaning: "The document does not say what portion this delivery rests.",
    whatToDo: "State the portion on the document before resting a delivery against it.",
  },
  {
    code: "stamp_delivery_exceeds_portion",
    status: 409,
    meaning: "This delivery is larger than the portion the document allows.",
    whatToDo: "Split the delivery, or publish a larger portion.",
  },
  {
    code: "stamp_delivery_unverified",
    status: 400,
    meaning: "The delivery was not verified against its payment.",
    whatToDo: "Wait for the payment to settle and read the delivery again.",
  },
  {
    code: "stamp_duplicate_payment",
    status: 409,
    meaning: "That payment has already been rested against a delivery.",
    whatToDo: "A payment rests once. Find the delivery it already rests against.",
  },
  {
    code: "stamp_payment_refused",
    status: 400,
    meaning: "The payment behind this delivery was refused.",
    whatToDo: "Read the payment's own record; the delivery is only as good as it.",
  },
  {
    code: "stamp_document_hash_mismatch",
    status: 400,
    meaning: "The document's hash does not match its content.",
    whatToDo: "The document was altered after it was hashed. Fetch it again.",
  },
  {
    code: "stamp_no_reviewers",
    status: 409,
    meaning: "No reviewer is available for this document.",
    whatToDo: "Wait for a reviewer, or submit it to the manual queue.",
  },
  {
    code: "stamp_not_funded",
    status: 409,
    meaning: "The document's funding has not been received, so nothing can rest against it yet.",
    whatToDo: "Fund the document, then read it again once the payment settles.",
  },
  {
    code: "stamp_team_allocation_unknown",
    status: 409,
    meaning: "This document has no team allocation, so a team share cannot be computed.",
    whatToDo: "Publish the team allocation with the document.",
  },
  {
    code: "stamp_structuring_held",
    status: 403,
    meaning: "The delivery was held because it looked like structuring.",
    whatToDo: "This is a deliberate hold for review. Read the reason and wait for the reviewer.",
  },
  {
    code: "update_failed",
    status: 500,
    meaning: "The update did not complete.",
    whatToDo: "Re-read the resource before retrying: the write may have partly applied.",
  },
];

export interface ApiContract {
  version: string;
  generatedAt: string;
  pagination: {
    style: string;
    parameters: { name: string; meaning: string }[];
    maxPage: number;
    response: { name: string; meaning: string }[];
    rule: string;
  };
  rateLimit: {
    limit: number;
    perMs: number;
    burst: number;
    scope: string;
    body: string;
  };
  authentication: {
    schemes: { name: string; how: string; use: string }[];
    rules: string[];
  };
  errors: ErrorCodeEntry[];
  webhooks: {
    signing: string;
    headers: { name: string; meaning: string }[];
    replayWindow: string;
  };
}

/**
 * Build the contract document.
 *
 * `generatedAt` is an ISO timestamp rather than a build hash: the document
 * describes the running API, and the running API is the only authority on
 * what it supports.
 */
export function buildApiContract(now: () => number = Date.now): ApiContract {
  return {
    version: API_VERSION,
    generatedAt: new Date(now()).toISOString(),
    pagination: {
      style: "cursor",
      parameters: [
        { name: "limit", meaning: "How many items to return. At most 500." },
        { name: "after", meaning: "The id of the last item you already have. Omit it for the first page." },
      ],
      maxPage: MAX_PAGE,
      response: [
        { name: "nextCursor", meaning: "The `after` value for the next page. Null when there is no next page." },
        { name: "truncated", meaning: "True when the page is not the whole list." },
      ],
      rule:
        "The cursor is an item id, not an offset. On a chain that only grows, an offset is a " +
        "different set of rows on every request. Asking for no limit returns the whole list — " +
        "a silent default cap would read as a shorter chain.",
    },
    rateLimit: {
      limit: DEFAULT_RATE_LIMIT.limit,
      perMs: DEFAULT_RATE_LIMIT.windowMs,
      burst: DEFAULT_RATE_LIMIT.burst,
      scope: "per client, per process",
      body:
        "Buckets refill continuously, so a steady caller gets a steady answer instead of a wall. " +
        "A refusal is 429 with a Retry-After header. The store is process-local: behind a load " +
        "balancer each instance keeps its own bucket, which is stated here rather than hidden.",
    },
    authentication: {
      schemes: [
        {
          name: "SIWE",
          how: "Sign the SIWE message with a wallet and send it as a bearer credential.",
          use: "Anything a person does: enrolling an agent, claiming a trial, reading what is yours.",
        },
        {
          name: "Organisation API key",
          how: "Send it as a bearer credential, scoped to the actions it was issued for.",
          use: "Server-to-server work: running evaluations, reading evidence, receiving webhooks.",
        },
      ],
      rules: [
        "Credentials never travel in a query string.",
        "An organisation API key can be revoked, and a revoked key stays revoked.",
        "The API holds no chain key: it can read the chain, and it can never sign for it.",
      ],
    },
    errors: ERROR_CATALOGUE,
    webhooks: {
      signing:
        "Each webhook carries an HMAC signature over the timestamp and the body, so a receiver can " +
        "prove the message came from this API and was not altered. The timestamp is inside the " +
        "signed material, so an old message cannot be replayed into a new one.",
      headers: [
        { name: "X-Crucible-Signature", meaning: "The HMAC signature, prefixed with its algorithm." },
        { name: "X-Crucible-Timestamp", meaning: "When the API signed the body." },
        { name: "X-Crucible-Delivery", meaning: "The delivery's id, for deduplication." },
      ],
      replayWindow: "A signature older than five minutes is refused.",
    },
  };
}
