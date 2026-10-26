import { describe, expect, it } from "vitest";
import { replay, type EventLike } from "@crucible/indexer";
import { createApp } from "../src/app.js";

/**
 * `GET /escrow/:wallet` — the escrow explorer's read (gate 838).
 *
 * The route owns one thing beyond the projection: the three states of the per-wallet credit
 * read. "This host does not read it", "the escrow was reached and the read failed" and
 * "the chain says 0.7" are three different answers to "can I withdraw now", and collapsing
 * the first two into a zero is how a pull ledger gets read as an empty account.
 */

const SPONSOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x2222222222222222222222222222222222222222";
const TRIALS = "0x4444444444444444444444444444444444444444";
const ETH = 10n ** 18n;

function ev(eventName: string, args: Record<string, unknown>, blockNumber = 1n): EventLike {
  return {
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    address: TRIALS,
    eventName,
    args,
  };
}

const model = replay([
  ev("TrialCreated", {
    id: 1n,
    sponsor: SPONSOR,
    specCID: "0xaa",
    testsCID: "0xbb",
    reward: 5n * ETH,
    bond: 1n * ETH,
    deadline: 1_700_000_000n,
    breakWindow: 43_200n,
  }),
  ev("AgentRegistered", {
    agentId: 1n,
    operator: OPERATOR,
    runner: OPERATOR,
    metadataURI: "ipfs://m",
    stake: 2n * ETH,
  }),
  ev("TrialClaimed", { id: 1n, agentId: 1n, bond: 1n * ETH }),
]);

function appFor(creditOf?: (wallet: string) => Promise<bigint | null>) {
  return createApp(
    {
      getModel: () => model,
      creditOf,
      proofSource: { chain: "Anvil", chainId: 31337, trialsAddress: TRIALS },
      indexStatus: () => ({ headTimestamp: 1_700_000_000 } as never),
    },
    { rateLimit: false },
  );
}

describe("the request", () => {
  it("refuses a string that is not an address before reading anything", async () => {
    const res = await appFor().request("/escrow/not-a-wallet");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/20-byte/);
  });

  it("answers a well-formed wallet with the locks it owns", async () => {
    const body = await appFor().request(`/escrow/${SPONSOR}`).then((r) => r.json());
    expect(body.held).toHaveLength(1);
    expect(body.held[0]).toMatchObject({ role: "sponsor", kind: "reward", eth: "5", trialId: 1 });
    expect(body.heldEth).toBe("5");
    expect(body.wallet).toBe(SPONSOR);
  });
});

describe("the credit read", () => {
  it("says the source is unconfigured when the host cannot read credit", async () => {
    const body = await appFor().request(`/escrow/${SPONSOR}`).then((r) => r.json());
    expect(body.creditSource).toEqual({
      configured: false,
      reason: "This host does not read per-wallet credit from the chain",
    });
    expect(body.withdrawableEth).toBeNull();
  });

  it("reports the chain's answer when the read lands", async () => {
    const app = appFor(async () => 7n * 10n ** 17n);
    const body = await app.request(`/escrow/${SPONSOR}`).then((r) => r.json());
    expect(body.withdrawableEth).toBe("0.7");
    expect(body.creditSource).toEqual({ configured: true, reason: null });
  });

  it("keeps a real zero distinguishable from an unread claim", async () => {
    const app = appFor(async () => 0n);
    const body = await app.request(`/escrow/${SPONSOR}`).then((r) => r.json());
    expect(body.withdrawableEth).toBe("0");
    expect(body.creditSource.reason).toBeNull();
  });

  it("calls an unread credit unread rather than zero when the read fails", async () => {
    const app = appFor(async () => null);
    const body = await app.request(`/escrow/${SPONSOR}`).then((r) => r.json());
    expect(body.withdrawableEth).toBeNull();
    expect(body.creditSource).toMatchObject({ configured: true });
    expect(body.creditSource.reason).toMatch(/read failed/);
  });

  it("names the failure and still answers 200 when the escrow could not be reached", async () => {
    // The locks came from the index and are true regardless; a node that will not answer the
    // extra read degrades one column, it does not make the whole page an error.
    const app = appFor(async () => {
      throw new Error("rpc down");
    });
    const res = await app.request(`/escrow/${SPONSOR}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.withdrawableEth).toBeNull();
    expect(body.creditSource.reason).toMatch(/rpc down/);
    expect(body.heldEth).toBe("5");
  });
});

describe("what the page is told to print", () => {
  it("names the contract holding the ETH", async () => {
    const body = await appFor().request(`/escrow/${SPONSOR}`).then((r) => r.json());
    expect(body.escrowAddress).toBe(TRIALS);
  });

  it("leaves the address unknown when the host does not supply one", async () => {
    const app = createApp({ getModel: () => model }, { rateLimit: false });
    const body = await app.request(`/escrow/${SPONSOR}`).then((r) => r.json());
    expect(body.escrowAddress).toBeNull();
  });

  it("gives the chain clock for a countdown, or null when this host has none", async () => {
    const withClock = await appFor().request(`/escrow/${SPONSOR}`).then((r) => r.json());
    expect(withClock.chainNow).toBe(1_700_000_000);

    const bare = createApp({ getModel: () => model }, { rateLimit: false });
    const noClock = await bare.request(`/escrow/${SPONSOR}`).then((r) => r.json());
    expect(noClock.chainNow).toBeNull();
  });

  it("carries wei precision through the JSON unchanged", async () => {
    // A float would drop the last digits; the page formats from this string, so the exact
    // remainder has to survive the route.
    const app = appFor(async () => 1_000_000_000_000_000_001n);
    const body = await app.request(`/escrow/${SPONSOR}`).then((r) => r.json());
    expect(body.withdrawableEth).toBe("1.000000000000000001");
  });
});

describe("separation", () => {
  it("does not mix the agent's bond column into the sponsor's answer", async () => {
    const sponsor = await appFor().request(`/escrow/${SPONSOR}`).then((r) => r.json());
    const operator = await appFor().request(`/escrow/${OPERATOR}`).then((r) => r.json());
    expect(sponsor.heldEth).toBe("5");
    expect(sponsor.stakedEth).toBe("0");
    expect(operator.heldEth).toBe("1");
    expect(operator.stakedEth).toBe("1");
  });
});
