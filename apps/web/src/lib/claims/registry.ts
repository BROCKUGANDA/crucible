/**
 * The claim matrix behind `/claims`.
 *
 * The landing page makes promises. This is the table that says, for each one, what enforces it —
 * and, just as importantly, which promises are ahead of the code. A page that listed only the kept
 * promises would be a marketing sheet with a `status` column bolted on, so the `absent` rows are
 * the reason to read it.
 *
 * Every `enforcedBy` path is checked to exist by `test/claims-registry.test.ts`, and a row cannot
 * be marked `enforced` without at least one such path. That is the only thing separating this file
 * from a list of adjectives.
 */

export type ClaimStatus = "enforced" | "partial" | "absent";

export interface Claim {
  id: string;
  /** the sentence, or the chip, as it reads where a visitor meets it */
  copy: string;
  /**
   * True when the words in `copy` are the words the landing page carries. The registry test then
   * requires the fragment to be found in `page.tsx`, so a row cannot invent site copy and claim the
   * site said it. Rows about mechanisms the site does not advertise leave it unset on purpose.
   */
  onSite?: boolean;
  status: ClaimStatus;
  /** repo-relative paths that carry the enforcement; a test asserts each one exists */
  enforcedBy: string[];
  /** what the row means when `status` is not the whole story */
  note: string;
}

export const CLAIMS: Claim[] = [
  {
    id: "H-2",
    onSite: true,
    copy: "Crucible puts their bond where their output is",
    status: "enforced",
    enforcedBy: ["crucible-contracts/contracts/CrucibleTrials.sol", "crucible-contracts/test/CrucibleTrials.t.sol"],
    note: "`BOND_DEN = 5` — a claim needs a bond of at least a fifth of the reward, and the escrow holds it.",
  },
  {
    id: "H-4",
    onSite: true,
    copy: "one credential — minted only from what survived",
    status: "enforced",
    enforcedBy: ["crucible-contracts/contracts/AlloyRegistry.sol", "crucible-contracts/test/AlloyRegistry.t.sol"],
    note: "The only mint is a lazy `_ensure` reached from `recordWin`/`recordSlash`, both `onlyForge`; the forge is this escrow, and a test asserts the owner cannot call it.",
  },
  {
    id: "H-5",
    onSite: true,
    copy: "no one can buy, borrow, or fake",
    status: "enforced",
    enforcedBy: ["crucible-contracts/contracts/AlloyRegistry.sol", "crucible-contracts/test/AlloyRegistry.t.sol"],
    note: "ERC-5192 `locked()` is true for a minted credential and the contract declares no `transferFrom`, `approve` or `setApprovalForAll` at all — non-transferability rests on there being no path, which the test pins.",
  },
  {
    id: "H-6",
    onSite: true,
    copy: "no one can buy, borrow, or fake",
    status: "enforced",
    enforcedBy: ["crucible-contracts/contracts/AlloyRegistry.sol", "apps/api/src/server.ts"],
    note: "No approval surface to lend, and the tier an application reads comes from the registry keyed to the agent's own id, not from a token sitting in a wallet.",
  },
  {
    id: "H-7",
    copy: "no one can fake it",
    status: "partial",
    enforcedBy: ["apps/web/src/app/.well-known/crucible.json/route.ts", "apps/web/src/app/verify/page.tsx"],
    note: "The deployment now publishes the addresses a record must come from, and `/verify` reads a receipt off the chain. What is missing is the other half: no SDK or CLI `verify(agent)` exists, so a third party can check an address but has no tool to run the check with.",
  },
  {
    id: "I-3",
    onSite: true,
    copy: "0.01 ETH",
    status: "enforced",
    enforcedBy: ["crucible-contracts/contracts/CrucibleTrials.sol", "apps/web/test/landing-claims.test.ts"],
    note: "`MIN_BOND = 0.01 ether` is what `createTrial` rejects a smaller reward against, and the copy is bound to that constant by a test rather than by memory. Other mints are not accepted at all, so no other floor is advertised.",
  },
  {
    id: "IV-3",
    onSite: true,
    copy: "a falsification that lands takes three-tenths of the bond",
    status: "enforced",
    enforcedBy: ["crucible-contracts/contracts/CrucibleTrials.sol", "apps/web/test/landing-claims.test.ts"],
    note: "`SLASH_SKEPTIC_NUM = 3_000` over `BPS`; the remainder goes to the treasury, and the sponsor is refunded the reward. The landing sentence and the contract constant are compared by test.",
  },
  {
    id: "V-2",
    onSite: true,
    copy: "two of three settles the trial",
    status: "enforced",
    enforcedBy: ["crucible-contracts/contracts/CrucibleTrials.sol", "crucible-contracts/test/CrucibleTrials.t.sol"],
    note: "`ARGUS_THRESHOLD = 2` against three seats fixed at construction.",
  },
  {
    id: "V-6",
    onSite: true,
    copy: "a panel that never forms does not hold the money",
    status: "enforced",
    enforcedBy: ["crucible-contracts/contracts/CrucibleTrials.sol", "apps/web/test/landing-claims.test.ts"],
    note: "After `DISPUTE_TIMEOUT = 3 days`, `finalize` settles a challenged trial for the agent. This is not a refund path — the arena's no-quorum outcome is a different contract that nothing here routes to.",
  },
  {
    id: "VI-3",
    onSite: true,
    copy: "The tier, the wins, the survivals and the slashes all read straight off the contract",
    status: "enforced",
    enforcedBy: ["apps/api/src/app.ts", "apps/api/test/standing.test.ts", "crucible-contracts/contracts/AlloyRegistry.sol"],
    note: "`GET /api/standing/:id` returns the registry tier, the book, the settled outcomes, the computed standing and the addresses to check them against. The chain's own one-call read is `records(agentId)`, which returns wins, survivals, slashes and tier together.",
  },
  {
    id: "VI-4",
    onSite: true,
    copy: "it fades with the age of what it is made of",
    status: "enforced",
    enforcedBy: ["packages/smith-sdk/src/standing.ts", "packages/smith-sdk/test/standing.test.ts", "params/crucible.params.json"],
    note: "Standing decays at `standing_half_life_days: 45` from the parameter source. That constant existed and was read by nothing until this row was true; a test now asserts the default reaches the computation.",
  },
  {
    id: "VI-5",
    copy: "the weight a difficulty and an independent sponsor would carry",
    status: "absent",
    enforcedBy: ["packages/smith-sdk/src/standing.ts"],
    note: "§18.2's `d` and `s` are held neutral (1.0 and 0.5) because nothing here measures suite difficulty or sponsor linkage. The API reports them as assumptions rather than folding a made-up factor into a score a reader would take as measured.",
  },
  {
    id: "VI-6",
    copy: "if the identity behind it changes hands, a new epoch starts from zero",
    status: "absent",
    enforcedBy: [],
    note: "There is no epoch anywhere: not in the registry, the ABI, the read model or params. A credential is one per agent forever, so an identity sold outright carries its history with it — which is the one case the soulbound token does not cover.",
  },
  {
    id: "VI-7",
    copy: "published to the ERC-8004 reputation registry",
    status: "partial",
    enforcedBy: ["crucible-contracts/contracts/ReputationBridge.sol", "crucible-contracts/test/ReputationBridge.t.sol"],
    note: "The bridge publishes after settlement and cannot revert it, and `backfill` is permissionless. But the registry on this deployment is a mock, and `getSummary` — the standard one-call aggregate a hiring application would use — is declared in the interface and implemented nowhere, so the reading path is ours, not the standard's.",
  },
  {
    id: "III-1",
    copy: "the run executes in a sealed sandbox",
    status: "partial",
    enforcedBy: ["packages/forge-runner/src/sandbox.ts"],
    note: "Docker with `--network=none`, a pinned verifier image digest and memory and CPU ceilings. The three agreeing replays the v2 copy describes are not run: one execution, one hash.",
  },
  {
    id: "I-4",
    copy: "a sealed holdout runs after the public suite",
    status: "absent",
    enforcedBy: [],
    note: "The legacy escrow stores two digests and no holdout commitment. The arena contract has holdout commit-reveal and is wired to no route, keeper job or page, so nothing a visitor can post uses it.",
  },
  {
    id: "R-1",
    copy: "replays read the beats back instead of retelling them",
    status: "enforced",
    enforcedBy: ["packages/frame/src/reducer.ts", "apps/api/src/replay.ts", "apps/web/src/app/trials/[id]/replay/page.tsx"],
    note: "A trial's own logs fold into frames through a pure reducer; each frame carries its hash and the whole replay one more, so a caption can point at the frame it described. Nothing about a replay is stored twice, because nothing about it is trusted without a digest.",
  },
];
