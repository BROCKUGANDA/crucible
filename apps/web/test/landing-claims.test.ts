import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * The landing page is a contract with whoever reads it, and until now nothing checked that the
 * sentences matched the escrow. `bun run copy:check` and `tests/claims/` from the v2.2 bible are
 * not this repository's shape (npm workspaces; no per-claim test tree), so this file does the part
 * that matters: every number the page states about money, windows or quorum is read out of
 * `CrucibleTrials.sol` and compared. A claim that cannot be bound is not asserted here.
 *
 * Each check is written to fail in the useful direction. If the contract's split changes, the copy
 * goes red. If the copy drifts, the copy goes red. If someone implements the one-call read the
 * page once promised, the ban on promising it lifts itself.
 */

const PAGE = fileURLToPath(new URL("../src/app/page.tsx", import.meta.url));
const TRIALS = fileURLToPath(new URL("../../../crucible-contracts/contracts/CrucibleTrials.sol", import.meta.url));
const ALLOY = fileURLToPath(new URL("../../../crucible-contracts/contracts/AlloyRegistry.sol", import.meta.url));
const STANDING = fileURLToPath(new URL("../../../packages/smith-sdk/src/standing.ts", import.meta.url));
const API_APP = fileURLToPath(new URL("../../../apps/api/src/app.ts", import.meta.url));
const CLAIMS_PAGE = fileURLToPath(new URL("../src/app/claims/page.tsx", import.meta.url));
const page = readFileSync(PAGE, "utf8");
const sol = readFileSync(TRIALS, "utf8");

/** `uint256 public constant NAME = <value>;` — the executed declaration, not a comment about it. */
function constant(name: string): string {
  const m = sol.match(new RegExp(`^\\s*(?:uint256|uint64|uint16) public constant ${name} = ([^;]+);`, "m"));
  const value = m?.[1];
  if (value === undefined) throw new Error(`${name} is not declared as a public constant in CrucibleTrials.sol`);
  return value.trim();
}

/** Solidity writes these with digit separators (`10_000`), which `Number()` reads as NaN. */
function numeric(name: string): number {
  return Number(constant(name).replace(/_/g, ""));
}

function weiToEth(literal: string): number {
  const [, amount = "", unit] = literal.match(/^([\d_.]+)\s*(ether|gwei)?$/) ?? [];
  if (amount === "") throw new Error(`cannot read an ETH amount from "${literal}"`);
  const n = Number(amount.replace(/_/g, ""));
  return unit === "gwei" ? n / 1e9 : n;
}

describe("the landing page's money claims, bound to the escrow", () => {
  it("states the slash split the contract actually pays", () => {
    const num = numeric("SLASH_SKEPTIC_NUM");
    const den = numeric("BPS");
    expect(den).toBe(10_000);
    // 3000/10000 is what _settleSlash:738 computes, and the page says it in words.
    expect(num / den).toBeCloseTo(0.3, 10);
    expect(page).toContain("three-tenths of the agent's bond");
    expect(page).toContain("takes three-tenths of the bond");
    // The sentence the v2.2 audit found live: the skeptic does not take the bond.
    expect(page).not.toMatch(/skeptic takes the (whole )?bond/i);
  });

  it("gives the treasury the remainder, and only because no panel is paid from it", () => {
    // `_settleSlash` credits `credit[treasury] += bond - skepticCut`. There is no seat fee in this
    // escrow, so "the rest goes to the treasury" is the truth today. The moment a panel payment is
    // added, this test fails and the copy has to be revisited — which is the whole point.
    expect(sol).toMatch(/credit\[treasury\] \+= bond - skepticCut/);
    expect(sol).not.toMatch(/seatFee|seat_fee|paySeat|ARGUS_FEE/);
    expect(page).toContain("the rest goes to the treasury");
    expect(page).not.toMatch(/after the panel is paid/i);
  });

  it("promises the sponsor a refund it performs", () => {
    expect(sol).toMatch(/credit\[t\.sponsor\] \+= reward;/);
    expect(page).toMatch(/refunds the sponsor/i);
  });

  it("binds the hung-panel sentence to DISPUTE_TIMEOUT", () => {
    expect(constant("DISPUTE_TIMEOUT")).toBe("3 days");
    expect(page).toMatch(/three days after a dispute opens/);
    // No quorum refund path exists in this escrow; that outcome belongs to the arena.
    expect(page).not.toMatch(/everyone is refunded/i);
  });

  it("states the floor the contract enforces, and no other mint's floor", () => {
    expect(weiToEth(constant("MIN_BOND"))).toBe(0.01);
    expect(page).toContain("0.01 ETH");
    // The product escrows native ETH. A chip offering USDC or SOL would advertise an asset the
    // contract cannot hold (AGENTS.md money rules), which is a product pivot, not a copy tweak.
    expect(page).not.toMatch(/Floor [0-9.]+ (USDC|SOL)/);
  });

  it("binds the quorum words to ARGUS_THRESHOLD", () => {
    expect(constant("ARGUS_THRESHOLD")).toBe("2");
    expect(page).toMatch(/two of three/i);
  });

  it("does not promise a one-call read that no contract implements", () => {
    const implementsOneCall = readFileSync(ALLOY, "utf8").includes("function getSummary") ||
      sol.includes("function getSummary");
    const promisesOneCall = /in one call/i.test(page);
    if (!implementsOneCall) expect(promisesOneCall).toBe(false);
  });

  it("keeps the tier claim inside what recordSlash does, and the fade claim inside the decay", () => {
    // A slash lowers wins by a quarter and recomputes the tier — that part was always true.
    expect(readFileSync(ALLOY, "utf8")).toMatch(/r\.wins = \(r\.wins \* 3\) \/ 4/);
    expect(page).toMatch(/tier (falls|decays)/);

    // The time-fade is the two-sided one. `standing_half_life_days` sat in params unread until
    // packages/smith-sdk/src/standing.ts computed with it, so the sentence is allowed exactly as
    // long as the computation exists and is reached by the API. Delete the decay and this fails —
    // which is the point: the copy cannot outlive the mechanism a second time.
    const decayImplemented =
      readFileSync(STANDING, "utf8").includes("DEFAULT_HALF_LIFE_DAYS") &&
      readFileSync(API_APP, "utf8").includes("computeStanding");
    const promisesFade = /fades with the age|half-life/i.test(page);
    expect(promisesFade).toBe(decayImplemented);
  });

  it("links the promise list it publishes, and the list links back to files", () => {
    expect(page).toContain("/claims");
    expect(existsSync(CLAIMS_PAGE)).toBe(true);
  });
});

describe("the published allowlist that makes “no one can fake it” checkable", () => {
  const savedTrials = process.env.NEXT_PUBLIC_TRIALS_ADDRESS;
  const savedAlloy = process.env.NEXT_PUBLIC_ALLOY_ADDRESS;

  afterEach(() => {
    process.env.NEXT_PUBLIC_TRIALS_ADDRESS = savedTrials;
    process.env.NEXT_PUBLIC_ALLOY_ADDRESS = savedAlloy;
  });

  it("publishes the deployment's addresses when they are set", async () => {
    const trials = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
    const alloy = "0xe7f1725E7734Ce288f8367e1Bb143E90bb3F0512";
    process.env.NEXT_PUBLIC_TRIALS_ADDRESS = trials;
    process.env.NEXT_PUBLIC_ALLOY_ADDRESS = alloy;
    const { GET } = await import("../src/app/.well-known/crucible.json/route.js");
    const body = (await GET().json()) as { contracts: Record<string, string | null> };
    expect(body.contracts.trials).toBe(trials);
    expect(body.contracts.alloy).toBe(alloy);
    expect(body.contracts.verificationReceipt).toBeNull();
  });

  it("publishes null rather than a zero address when the build forgot one", async () => {
    delete process.env.NEXT_PUBLIC_TRIALS_ADDRESS;
    process.env.NEXT_PUBLIC_ALLOY_ADDRESS = "not-an-address";
    const { GET } = await import("../src/app/.well-known/crucible.json/route.js");
    const body = (await GET().json()) as { contracts: Record<string, string | null> };
    expect(body.contracts.trials).toBeNull();
    expect(body.contracts.alloy).toBeNull();
    // A reader filtering on 0x0000… would drop every real record; that is why this cannot be zero.
    expect(JSON.stringify(body)).not.toMatch(/0x0{40}/);
  });
});
