# DECISIONS — resolved or defaulted, with the reading chosen

Gate 733 (v2 bible §28). Every D-entry carries its default, the reason, and — where the
bible and this repository's existing law met — which one won and why. Authority order:
ADR/AGENTS.md law → params → existing code+tests → the bible's new specifications.

| Id | Decision | Default taken | Reading / note |
| --- | --- | --- | --- |
| D-1 | Break-landed split | **Arena: 30% skeptic / 70% treasury** (`break_prize_bps: 3000`). Legacy `work-escrow` keeps 50/50, frozen as `LEGACY_BREAK_SPLIT_BPS_V1` | The copy's stage-IV promise wins for v2; v1 semantics never change (ADR-0011) |
| D-2 | Failed-break stake | **Treasury** (`FAILED_BREAK_SINK`) | Agents must never profit from their own alt wallets' junk breaks |
| D-3 | Forfeits | Timeout 10% of B to the sponsor; yield 0% + cooldown | `claim_timeout_forfeit_bps: 1000`, `yield_cooldown_seconds: 86400` |
| D-4 | Reward floors | 0.01 ETH · 10 USDC · 0.1 SOL | In `params.json` as per-mint base-unit strings — never floats |
| D-5 | Vote reveal window | **24 h**, matching commit | Both windows 86400 s |
| D-6 | Seat economics | 50 bps/seat/break fee; bond ≥ 5× earnable; 20% slash for no-shows only; minority votes never slashed | Invariant 1 proves seats payable from the minimum bond |
| D-7 | Decay & seasons | Half-life 45 d; season 42 d | Standing display = 500 + 250×Standing |
| D-8 | Clock | **Unix timestamps** (`Clock::unix_timestamp` / `block.timestamp`) | v1's `SLOTS_PER_SECOND_ESTIMATE = 2` stays in `work-escrow` as legacy, UI-estimates only — this corrects a real drift bug (G14) |
| D-9 | Program layout | New `crucible-arena` + `Arena.sol` beside untouched v1 | Never rename v1 identifiers (AGENTS.md rule 17 agrees) |
| D-10 | Reputation home | **Both chains**: ERC-8004 on Base Sepolia + Solana Agent Registry, indexer-mirrored, no bridge | Publish is best-effort + `republish`, never blocks settlement |
| D-11 | Target event | **Colosseum Eternal** (November window) first; next Colosseum hackathon second | World's Fair closed 2026-10-12 — do not build to it |
| D-12 | Randomness | VRF both chains (Switchboard/ORAO; Chainlink v2.5); slot-hash fallback devnet-only and labelled | Deterministic randomness acceptable in P3/P4 tests |
| D-13 | Anchor version | **Stay on 0.30.1** | Amended for this machine in `crucible-contracts/solana/Anchor.toml`: solana-labs v1.18.26 replaces the unreachable agave pins — the era-correct pairing, proven green 10/10 |
| D-14 | `K_FLOOR` vs new invariants | **Report only** | Legacy `math.rs` formula recorded, never silently changed |
| D-15 | Patron vaults | **Deferred** (stretch, needs legal review) | Not in the hackathon build |
| D-17 | Arena randomness on the demo | **Mode 0**, a deterministic seed: `keccak256(prevrandao, block.number, id, round)` | The devnet fallback D-12 already allows, now recorded rather than left as script behaviour. Mode 1 fails closed (`RandomnessNotConfigured`) until a consumer is wired, so the only panel a demo can draw is mode 0 — and it is **not** a VRF: a validator influences both `prevrandao` and `block.number`. `Demo.s.sol` names it in the comment beside the constructor |

## Conflicts found between the bible and this repo, and the readings taken

1. **Fee (the big one).** Bible: 1500 bps arena fee. Repo law: 500 bps, 15% named as the
   trap. Reading: both are true in their spheres — resolved by ADR-0011 (params-driven
   arena fees; legacy frozen at 500 and machine-checked against drift by gate 732's
   legacy-freeze assertion, proven to fail red on mutation).
2. **"EVM contracts never compiled" (bible G6).** False here: this repo's Foundry suite is
   green (144 tests, coverage-gated). The bible described the *other* environment's tree.
   Reading: P3 starts from a compiled, tested base; `Arena.sol` is additive.
3. **Program id `7Tvrs…` "gone green" (bible §10.7).** In this repo that id's keypair never
   existed; the local e2e went green on a re-synced id recorded in `Anchor.toml`.
   Reading: ids are per-environment; the toolchain is the pin (AGENTS-recorded).
4. **Layout.** Bible paths (`download/crucible`, Bun) map to this repo (npm workspaces,
   `crucible-contracts/solana`). Reading: this repo's structure wins; the bible's
   *contents* are adopted, not its directory names.
5. **Arena mints.** Bible §7.4 and D-4 want an allowlist of wrapped SOL, devnet USDC, Base Sepolia
   USDC and native ETH. Reading: **native ETH only**, in the arena too. ADR-0002 and
   contract-spec.md:20-21 are the repo's law, and the balance-delta token policy the bible asks
   for exists to defeat fee-on-transfer tokens — a hazard this chain does not have. `reward_floor`
   keeps its usdc/sol entries as data with no consumer, and `REWARD_FLOOR_WEI` is the Eth one.
6. **Partial quorum at the round cap.** §6.4.5 says "still unresolved after MAX_ARGUS_ROUNDS: O8,
   everyone is refunded", and a trial can reach the cap with some breaks decided and one hung.
   Reading: **O8 for the whole trial**. A verdict nobody could finish is not a verdict, and paying
   out a bond against a partial ballot is where an agent loses money to a jury that gave up.
7. **A retry needs a bigger pool than the first round.** §6.4.1 excludes round-1 seats from
   round 2, so a three-seat pool cannot retry a hung jury at all. Reading: the draw **fails
   closed** (`NotEnoughSeats`) and the docket waits for O8's exit rather than reusing a jury.
   Recorded because it is a real operating constraint on whoever runs seats.
8. **Seat bond floor.** `SEAT_BOND_MIN` is "5 × the fees a seat can earn on the trial", and one
   trial can put a seat on MAX_DOCKET breaks. Reading: `share × MAX_DOCKET × 5` — the worst case,
   so invariant 1 (seats always payable from the bond) holds on-chain and not only in the
   codegen test. `_settleLanded` reverts `BondShortfall` rather than pay a bond it does not have.
9. **Filing is unlimited, judging is bounded, and both need a number.** §6.3.2 wants unlimited
   filing; `freezeDocket` ranks with a bounded selection pass, so an unbounded filing list is an
   unbounded gas bill for whoever cranks it. Reading: **`MAX_FILING = 64`** breaks may be filed
   per trial; past that the deposit is refused. 8 of those 64 are judged.
10. **Ghost-ledger convention.** `paidOut` counts every wei the trial routed out, including the
    bond's three exits (prize, seat pools, treasury remainder) as one whole, so
    `paidOut == deposited` at settlement is a check and not an approximation.
11. **v2.1's Showcase Arena and Frenchy (gates 796–805) are read, judged, and not built.** The
    bible's own dependency note (§16.13.6) puts Ghost Runs behind P5 (Harena) and P3/P4, Frenchy
    behind gate 801 plus the P7 indexer, and House Bouts behind gate 796 — a second deployment
    on Base Sepolia with `gUSDC`/`gSOL` play money. What exists to build on is the arena contract
    and the escrow; the indexer, Standing and the agent surface (P7/P8) do not exist yet, so
    there is nothing for a showcase to showcase. Two of its claims are already law here rather
    than new work: an artifact cannot cross deployments because the EIP-712 `verifyingContract`
    and `chainId` are inside the signed digest (`Arena.sol` `DOMAIN`, asserted at
    `Arena.t.sol` `test_738_Submit_DomainBindsTheChainAndThisContract`), and writes are already
    simulated before they are signed (`packages/smith-sdk/src/client.ts`, `simulateContract`
    before every send) — gate 804's premise is half-shipped.
12. **D-16 (Frenchy's voice) meets an existing decision, not a blank page.** The repo already
    has an optional voice host and refused the interactive variant in advance:
    `docs/adr/0009-optional-voice-host.md:47` rejects "an interactive voice agent (WebSocket +
    STT)", and `docs/security-whitepaper.md:231` lists a second stream or WebSocket as a
    forbidden change. Text-first with the existing host is compatible; "the room calls a Worker
    through a Queue" is not, and would need a new ADR like the Postgres/Ponder case in §16.1.
13. **No profiles in `params/` until something consumes one.** §5.2 asks for a `showcase` profile
    compiled into a second deployment. `scripts/params-codegen.mjs` has no profile concept and the
    arena's own generated constants only just acquired a consumer (`Params.sol`); adding a second
    profile with no deployment to compile into would be the same title-only artefact the gate
    register is already full of, so it is deferred with the deployment it belongs to.
14. **v2.2's §30.3 was audited claim by claim, and three of its nine "fixes" would have made the
    live site lie.** Accepted, because the code already does the thing the sentence denies: the
    Stage V slash split (`_settleSlash` credits the sponsor the full reward, the skeptic
    `bond * 3_000 / 10_000` plus their stake, treasury the remainder) and the hung-panel exit
    (`DISPUTE_TIMEOUT = 3 days`, after which `finalize` settles for the agent — not "everyone is
    refunded", which is the arena's O8 and belongs to a contract nothing here uses). Rejected:
    **"the rest, after the panel is paid, goes to the treasury"** — there is no seat fee anywhere in
    the legacy escrow, so that sentence would describe the unwired arena; **"Floor 10 USDC /
    0.1 SOL"** and **"Ed25519 on Solana"** — the product escrows native ETH (ADR-0001), and `work-escrow`
    has six instructions with no credential, panel or holdout to sign for; and the Stage VI promise
    that any hiring app can **"read the record in one call"**, which was already on the site while
    `getSummary` exists only as an interface declaration (`IERC8004.sol:44`), never implemented.
    The machinery verdicts: `bun run copy:check` is dead on arrival (npm-11 workspaces), so the
    binding lives as `apps/web/test/landing-claims.test.ts`, which reads the constants out of
    `CrucibleTrials.sol` and fails if the words and the numbers disagree (proved: moving
    `SLASH_SKEPTIC_NUM` to 4000 reddens it); `/claims`, `tests/claims/`, `stages.ts`, identity
    epochs and time decay remain genuinely absent (**superseded on 2026-10-24 by 16, which builds
    `/claims` and gives the decay a consumer; `tests/claims/`, `stages.ts` and identity epochs
    still are** — identity epochs were built the same day by 17, and the `getSummary` clause two
    lines above was wrong, corrected by 18); and the two CTAs the ledger called unrouted
    (`/bounties`, `/hall`) already answer 200, while nothing in the repo links `/skeptics`, so that
    redirect would be a route to nowhere. `/.well-known/crucible.json` was added to give "no one can
    fake it" something to check against, and it publishes `null` for an unbaked address rather than
    a zero one, because a reader filtering on `0x0000…` would drop every real record.
15. **The replay reads the chain back instead of storing lines, and that is a divergence from
    §16.13.3 made on purpose.** The bible says "every line is stored with its frame hash, moment id
    and prompt version in Postgres; audio goes to R2. Replays read lines back instead of
    regenerating them." ADR-0008 admits no database to this repository, so the replay regenerates —
    and the guarantee the store was there to provide is kept a different way: the reducer is pure, so
    the same logs fold to the same frames on any machine, each frame carries its own `frameHash`
    through the one crypto door, and the whole replay carries `replayHash`. What that gives up is
    honest to name: a stored line survives a decode-rule change and a re-derived one does not, so
    `test/fixtures/{paid-with-break,slashed}.json` and the pinned golden hash are what make a drift
    visible instead of silent. Commentary follows the same shape — Frenchy's existing static pools
    (gate 674 forbids a runtime model), deterministic from `f(replay-<trialId>, trigger, history)`,
    so a replay's captions repeat exactly and cost nothing.
16. **The standing formula is implemented with the two terms it cannot measure held neutral and
    *reported*, not invented, and the promise list publishes its own gaps.** §18.2's
    `Standing = Σ(w·o·δ)/(Σ w·δ + 3)` needed three things this repository did not have: an outcome's
    settlement time, a consumer for `STANDING_HALF_LIFE_DAYS`, and a place to read the result. The
    first is a read-model change — `TrialRow` recorded created, submitted and dispute-opened but not
    settled, so an age had to be borrowed from a neighbouring event and a trial that sat in dispute
    for a week would decay as though it settled the day it ran; `settledAt` now comes from
    `VerdictFinalized`'s own block, and an outcome still missing one is **excluded and counted** in
    `meta.excludedNoSettlementTime` rather than aged on a guess. The second and third are
    `packages/smith-sdk/src/standing.ts` and `GET /api/standing/:id`.
    `d` (difficulty, 0.5–1.5) and `s` (sponsor independence, 0/0.5/1) are held at 1.0 and 0.5 — the
    midpoints that leave `w` as the money term alone — and the endpoint returns them as
    `meta.assumptions`, each with a `needs` line saying what would have to exist to replace the
    placeholder. The alternative was a per-suite difficulty derived from pass rates in the same
    in-memory model, which would have made the displayed score a function of what the indexer happened
    to hold, and a number a judge cannot check is worse than a number labelled unknown. This is the
    same rule the display follows for money: `—`, never a fabricated `0`.
    `/claims` (`apps/web/src/lib/claims/registry.ts` + the page) states each promise with the path
    that enforces it and an explicit `absent` for the ones nothing enforces, gated by
    `apps/web/test/claims-registry.test.ts`, which requires ≥1 cited file for an `enforced` row,
    checks every cited path exists, and **requires at least three rows to stay `absent`** so clearing
    that assertion means fixing a promise instead of relabelling it. A row may quote the landing page
    only if the page actually carries the words.
    Correction to 14, in my own words rather than silently: I recorded this morning that "no one-call
    read exists anywhere". Half right — `getSummary` is still an unimplemented interface declaration,
    but `AlloyRegistry.records` is a public mapping of a four-field struct, so `records(agentId)` was
    always one call answering wins, survivals, slashes and tier. The Stage VI sentence was false
    because it pointed at an ERC-8004 aggregate nothing here serves, not because the chain could not
    answer. The remedy chosen is the reader that makes the sentence true over HTTP, because an
    on-chain `getSummary` would be a contract change, and a contract change here is a chain reset on
    the box that serves the public site — a redeploy of eight settled trials' history to buy a getter
    the same page can compose from two existing reads.
17. **Identity epochs built the observed way, and the reset was made legible rather than
    impossible.** §18's epoch promise (gate 748, `/claims` row `VI-6`) was refused by an earlier
    reading of this ledger as "genuinely absent, worth building"; it is built now, and the shape it
    took is the decision worth recording. A handover is **observed, not declared**: the escrow asks
    the wired ERC-8004 registry who owns the linked identity at every settlement, and
    `AlloyRegistry` turns the window over when the answer changes. The alternative — a
    `startEpoch` the operator calls — is a reset button, because the same transaction that sells an
    identity legitimately is indistinguishable from one seller sending it to themselves to clear a
    landed break. What resets is the window (`wins`, `survived`, `slashes`, so the buyer starts at
    `Unforged` and re-earns); what never resets is `epoch`, `lifetimeWins`, `lifetimeSlashes`, the
    `EpochStarted` trail and the soulbound `ownerOf`, and the credential's own `tokenURI` carries all
    of it, so a reader with the NFT and no trust in this API can tell a short record from a washed
    one. Stated as a limit rather than discovered later: **an epoch makes washing visible; it does
    not make it impossible, and nothing here punishes the attempt**, because the attempt is also the
    legitimate case — punishing it would be the buyer inheriting the seller's history, which is the
    thing the promise exists to stop. The identity read fails open on every path (unwired registry,
    unlinked agent, revert, empty return, a zero answer) on the policy `ReputationBridge` already
    states: a verdict cannot be undone, a missed transition is seen at the next settlement. Row
    `VI-8` was added in the same commit — the standard's own `getSummary` aggregate is still
    unimplemented **(this clause is wrong; 18 corrects it, and the row it describes moves to
    `enforced`)** — so the matrix keeps three `absent` rows without inventing a promise to replace
    the one this fixed.
18. **The `getSummary` clause in 14 and 17 was wrong, and the promise it denied was failing for a
    different reason than I recorded.** I wrote twice that `getSummary` "exists only as an interface
    declaration, never implemented", and built `/claims` row `VI-8` on it. It is implemented — in
    `MockReputationRegistry`, with the standard's own signature, and `test/ReputationBridge.t.sol`
    has been reading it since the bridge landed. What was actually missing is one line of wiring:
    the demo chain left `trials.reputationBridge()` at `address(0)`, so no verdict ever reached the
    registry and the aggregate read correctly answered zero across four settled trials. That is a
    worse finding than the one I recorded, not a better one — a getter that works over a record
    nobody wrote is exactly the shape this ledger claims to watch for, and I mislabelled it as an
    absent feature because I grepped the escrow and the alloy registry for a function that lives in
    the reputation registry.
    Fixed in the same direction as the mistake: `Demo.s.sol` deploys and wires the registry and the
    bridge, and — the part the ordering made load-bearing — moves the identity links *before* the
    trial loop, because the bridge resolves the ERC-8004 subject at settlement and an unlinked agent
    publishes nothing but a `FeedbackSkipped`. Measured on a freshly seeded local chain: identity 1
    answers 2 writes and 1500, identity 2 answers 2 writes and 350 — a survived win plus a landed
    break on the 0–1000 scale the bridge declares. The mock's `setAgent` step is named in the script
    rather than passed off as the standard's own behaviour: a real registry learns about an agent
    from the identity registry it is paired with, and this double keeps a separate map.
    `VI-8` moves to `enforced` and `VI-7`'s note stops claiming the getter is missing. The `absent`
    floor would have been quietly satisfied by leaving `VI-8` mislabelled, so the row that replaces
    it is a promise this repository genuinely does not keep: `III-2`, three independent replays
    agreeing before a verdict stands — one execution and one run hash today. The landing gate that
    bans promising a one-call read now checks the registry *and* the wiring, and was proved to bite
    both ways: promise it with the seed unwired and it reddens, promise it with the wiring present
    and it stays green.
