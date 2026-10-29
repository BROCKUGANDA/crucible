import { afterAll, afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { emptyModel } from "@crucible/indexer";
import { createApp } from "../src/app.js";
import { dlq } from "../src/dlq.js";
import { OwnerGate, SponsorshipQueue, type SponsorshipApplication } from "../src/sponsorship.js";

/**
 * The sponsorship queue - the owner's side of the faucet.
 *
 * The thing being tested is a notification, so the tests are written from the
 * owner's side: did the owner hear about the application, and does the record
 * of it survive whatever the notice did? An application that was granted and
 * an application that was refused are both applications, and a queue that only
 * holds the successes would tell the operator "nothing happened" when a wallet
 * was turned away.
 */

const OWNER = `0x${"11".repeat(20)}`;
const APPLICANT = `0x${"22".repeat(20)}`;
const STRANGER = `0x${"33".repeat(20)}`;

let funder: http.Server | null = null;

/**
 * A stand-in for the funder.
 *
 * The funder holds the CDP credential and is not reachable from a test, so the
 * tests speak to a socket that answers the way the funder answers: `allocate`
 * with the funder's own shape, `allocations` with the funder's ledger.
 */
async function fakeFunder(handlers: {
  allocate?: { status: number; body: unknown };
  allocations?: { status: number; body: unknown };
}): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const answer =
        req.url === "/allocate"
          ? (handlers.allocate ?? {
              status: 200,
              body: {
                ok: true,
                wallet: APPLICANT,
                requestedEth: "0.05",
                grantedEth: "0.05",
                transferId: "tx-1",
                reason: null,
              },
            })
          : (handlers.allocations ?? { status: 200, body: { allocations: [] } });
      res.statusCode = answer.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer.body));
    });
    server.listen(0, "127.0.0.1", () => {
      funder = server;
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

afterEach(() => {
  dlq.clear();
});

afterAll(async () => {
  if (funder) await new Promise<void>((resolve) => funder!.close(() => resolve()));
});

/** An API with a sponsorship queue, an owner list, and an optional notice. */
function apiWith(options: {
  funderUrl?: string;
  owners?: string[];
  notify?: (application: SponsorshipApplication) => Promise<void>;
}) {
  const queue = new SponsorshipQueue();
  return {
    queue,
    app: createApp(
      {
        getModel: () => emptyModel(),
        ...(options.funderUrl ? { funderUrl: options.funderUrl } : {}),
        sponsorship: {
          queue,
          owners: new OwnerGate(options.owners ?? []),
          ...(options.notify ? { notify: options.notify } : {}),
        },
      },
      { rateLimit: false },
    ),
  };
}

function apply(app: ReturnType<typeof createApp>, wallet = APPLICANT, amountEth = 0.05) {
  return app.request("/faucet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, amountEth }),
  });
}

describe("an application reaches the owner", () => {
  it("records a grant and tells the owner about it", async () => {
    const f = await fakeFunder({});
    try {
      const told: SponsorshipApplication[] = [];
      const { app } = apiWith({ funderUrl: f.url, owners: [OWNER], notify: async (a) => void told.push(a) });

      const res = await apply(app);
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);

      expect(told).toHaveLength(1);
      expect(told[0].outcome).toBe("granted");
      expect(told[0].wallet).toBe(APPLICANT.toLowerCase());
      expect(told[0].requestedEth).toBe("0.05");
      expect(told[0].grantedEth).toBe("0.05");

      const queue = await app.request(`/faucet/applications?wallet=${OWNER}`);
      expect(queue.status).toBe(200);
      const body = await queue.json();
      expect(body.owner).toBe(true);
      expect(body.applications).toHaveLength(1);
      expect(body.applications[0].id).toBe(told[0].id);
    } finally {
      await f.close();
      funder = null;
    }
  });

  it("records a refusal as well, because a refusal is an application", async () => {
    const f = await fakeFunder({
      allocate: {
        status: 402,
        body: {
          ok: false,
          wallet: APPLICANT,
          requestedEth: "0.05",
          grantedEth: null,
          transferId: null,
          reason: "funder daily cap of 1 ETH would be exceeded",
        },
      },
    });
    try {
      const told: SponsorshipApplication[] = [];
      const { app } = apiWith({ funderUrl: f.url, owners: [OWNER], notify: async (a) => void told.push(a) });

      const res = await apply(app);
      expect(res.status).toBe(402);

      expect(told).toHaveLength(1);
      expect(told[0].outcome).toBe("refused");
      expect(told[0].grantedEth).toBeNull();
      expect(told[0].reason).toMatch(/daily cap/);
    } finally {
      await f.close();
      funder = null;
    }
  });

  it("records an application this host could not answer at all", async () => {
    const told: SponsorshipApplication[] = [];
    const { app } = apiWith({ owners: [OWNER], notify: async (a) => void told.push(a) });

    const res = await apply(app);
    expect(res.status).toBe(200);
    expect((await res.json()).fundable).toBe(false);

    expect(told).toHaveLength(1);
    expect(told[0].outcome).toBe("unanswered");
    expect(told[0].reason).toMatch(/no funder/);
  });

  it("does not turn a broken notice into a refused application", async () => {
    const f = await fakeFunder({});
    try {
      const { app } = apiWith({
        funderUrl: f.url,
        owners: [OWNER],
        notify: async () => {
          throw new Error("webhook responded 500");
        },
      });

      const res = await apply(app);
      // The applicant's answer is the funder's answer. A dead webhook is the
      // owner's problem, and it must not be billed to the applicant.
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);

      // The failure is still recorded, so the owner can see that the notice
      // channel is broken rather than wondering why nobody was told.
      expect(dlq.summary().lastKind).toBe("sponsorship.notify");
      expect(dlq.summary().lastDetail).toMatch(/webhook responded 500/);

      // And the application is in the queue regardless.
      const queue = await app.request(`/faucet/applications?wallet=${OWNER}`);
      expect((await queue.json()).applications).toHaveLength(1);
    } finally {
      await f.close();
      funder = null;
    }
  });

  it("keeps the newest application first", async () => {
    const f = await fakeFunder({});
    try {
      const { app } = apiWith({ funderUrl: f.url, owners: [OWNER] });
      await apply(app, APPLICANT);
      await apply(app, STRANGER);

      const body = await (await app.request(`/faucet/applications?wallet=${OWNER}`)).json();
      expect(body.applications).toHaveLength(2);
      expect(body.applications[0].id).toBeGreaterThan(body.applications[1].id);
    } finally {
      await f.close();
      funder = null;
    }
  });
});

describe("the queue is the owner's view", () => {
  it("tells a wallet that is not the owner that the queue is not for it", async () => {
    const { app } = apiWith({ owners: [OWNER] });
    const res = await app.request(`/faucet/applications?wallet=${STRANGER}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.owner).toBe(false);
    expect(body.applications).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("says so when this host has no owner configured", async () => {
    const { app } = apiWith({ owners: [] });
    const res = await app.request(`/faucet/applications?wallet=${OWNER}`);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/no owner wallet is configured/);
  });

  it("says so when this host keeps no queue at all", async () => {
    const app = createApp({ getModel: () => emptyModel() }, { rateLimit: false });
    const res = await app.request(`/faucet/applications?wallet=${OWNER}`);
    expect(res.status).toBe(501);
    expect((await res.json()).applications).toBeNull();
  });

  it("answers with no applications rather than an empty list when there were none", async () => {
    const { app } = apiWith({ owners: [OWNER] });
    const body = await (await app.request(`/faucet/applications?wallet=${OWNER}`)).json();
    expect(body.applications).toEqual([]);
  });
});

describe("the treasury's ledger", () => {
  it("shows the owner what the funder handed out", async () => {
    const f = await fakeFunder({
      allocations: {
        status: 200,
        body: {
          allocations: [
            {
              wallet: APPLICANT.toLowerCase(),
              requested: 0.05,
              estimated: 0.05,
              granted: 0.05,
              at: "2026-10-29T12:00:00.000Z",
              ok: true,
              reason: null,
            },
          ],
        },
      },
    });
    try {
      const { app } = apiWith({ funderUrl: f.url, owners: [OWNER] });
      const res = await app.request(`/faucet/ledger?wallet=${OWNER}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allocations).toHaveLength(1);
      expect(body.allocations[0].granted).toBe(0.05);
    } finally {
      await f.close();
      funder = null;
    }
  });

  it("does not answer the ledger to a wallet that is not the owner", async () => {
    const f = await fakeFunder({});
    try {
      const { app } = apiWith({ funderUrl: f.url, owners: [OWNER] });
      const res = await app.request(`/faucet/ledger?wallet=${STRANGER}`);
      expect(res.status).toBe(403);
      expect((await res.json()).allocations).toBeNull();
    } finally {
      await f.close();
      funder = null;
    }
  });

  it("does not answer the ledger with an empty one when the funder could not be reached", async () => {
    const { app } = apiWith({ funderUrl: "http://127.0.0.1:1", owners: [OWNER] });
    const res = await app.request(`/faucet/ledger?wallet=${OWNER}`);
    expect(res.status).toBe(502);
    expect((await res.json()).allocations).toBeNull();
  });
});
