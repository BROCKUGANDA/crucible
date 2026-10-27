import { createServer } from "node:http";
import { join } from "node:path";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { ContentBridge, CidStore, DisclosureLog } from "@crucible/cidstore";
import { ContentService, DEFAULT_SANDBOX, resolveVerifierImage } from "@crucible/forge-runner";
import { LiveVerifier } from "@crucible/argus";
import { CircuitBreaker, Flags, digestOfContent, envKillSwitches } from "@crucible/smith";
import { Scribe, TRIALS_SOURCE, disputeState, listTrials } from "@crucible/indexer";
import { readConfig } from "./config.js";
import { CrucibleChain } from "./chain.js";
import { DurableSeat } from "./cast.js";
import { FileState } from "./state.js";
import { assembleChainFacts, toRunFacts } from "./facts.js";
import { createOperator, type IndexPort, type JudgePort } from "./operator.js";
import { createPatrolLoop } from "./patrol.js";

/**
 * The Argus seat as a service.
 *
 * A Challenged trial is a dispute three named seats must decide, and until now no process
 * existed that could decide one: `@crucible/argus` could re-run a pinned suite and produce a
 * verdict, `CrucibleTrials` could accept a commit and a reveal, and nothing joined the two to a
 * wallet. That gap is why the deterministic-verifier story read as decorative — the oracle had
 * no voice on chain, so every dispute in the demo settled by the `DISPUTE_TIMEOUT` fallback that
 * pays the agent.
 *
 * This is the voice, and the rules it obeys are the contract's:
 *
 *   - it votes only inside `COMMIT_WINDOW` of the dispute opening, both read from the chain;
 *   - it seals only a verdict the deterministic re-run actually supports. An `abstain` report is
 *     recorded with its reason and never converted into a commitment, because the product's
 *     designed fallback for a committee that cannot decide is to pay the agent, and a seat that
 *     voted from its own outage would be voting against the skeptic;
 *   - it unseals only once `ARGUS_THRESHOLD` seats have committed (ADR-0004) — a count only the
 *     `VoteCommitted` logs can give, since `_disputes` is private and neither view enumerates
 *     its holders;
 *   - it writes its salts to disk before it posts them, so a restart can still finish a vote it
 *     already cast. See `state.ts`.
 *
 * Configuration is four required variables and one refusal (`config.ts`): no key is ever
 * assumed, and a seat the constructor did not grant exits at boot rather than looping against a
 * `NotArgus` revert. Nothing here prints a private key or an unopened salt: `/health` reports the
 * seat's address, which is public, and how many seals are pending, which reveals nothing.
 */

/** The store the seat reads, wired exactly as `scripts/seed-content.mjs` and `verify-roundtrip` do it. */
async function openContent(contentDir: string): Promise<ContentService> {
  return new ContentService({
    bridge: new ContentBridge({
      store: new CidStore({ dir: join(contentDir, "store") }),
      disclosure: await DisclosureLog.open(join(contentDir, "disclosure")),
      digestOf: digestOfContent,
    }),
  });
}

async function boot(): Promise<void> {
  const cfg = readConfig();

  // The re-run budget becomes the seat's slack: a pass may not start a job it cannot finish
  // inside the commit window, so the margin is the sandbox's own ceiling plus a minute for the
  // rest of the pass. Derived from the spec rather than typed in, so changing one cannot leave
  // the other behind.
  const marginSec = DEFAULT_SANDBOX.timeoutSec + 60;
  const chain = new CrucibleChain({
    rpcUrl: cfg.rpcUrl,
    trialsAddress: cfg.trialsAddress,
    account: cfg.account,
    marginSec,
  });

  try {
    await chain.connect();
  } catch (err) {
    console.error(`[juror] cannot use the node at ${cfg.rpcUrl}: ${(err as Error).message}`);
    process.exit(1);
  }

  const constants = await chain.constants();
  const granted = await chain.isArgus();
  console.log(
    `[juror] seat ${chain.seat} on chain ${chain.chainId} against ${cfg.trialsAddress} — ` +
      `commit window ${constants.commitWindowSec}s, quorum ${constants.threshold}, ` +
      `${granted ? "GRANTED (isArgus says yes)" : "NOT GRANTED (isArgus says no)"}`,
  );
  if (!granted) {
    // Refuse to loop. An ungranted seat reverts `NotArgus` on every call, so a patrol here would
    // be an unbounded supply of doomed transactions against a shared node, and the fix is not
    // time — it is the constructor's seat list, or the wrong key in `SEAT_PRIVATE_KEY`.
    console.error(
      `[juror] refusing to start: ${chain.seat} is not an Argus seat on this chain. Set SEAT_PRIVATE_KEY ` +
        "to one of the addresses the constructor granted (crucible-contracts/script/Demo.s.sol derives " +
        "the demo's three from the Anvil mnemonic at index 1, 2 and 3).",
    );
    process.exit(1);
  }

  const content = await openContent(cfg.contentDir);
  console.log(
    `[juror] content store ${cfg.contentDir} — the bytes behind every run hash live there, and ` +
      "scripts/seed-content.mjs is what puts them there",
  );

  const state = await FileState.open(cfg.stateDir);
  const pending = await state.pending();
  console.log(`[juror] seat state ${cfg.stateDir} — ${pending.length} unopened commitment(s) recovered`);

  const scribe = new Scribe({
    source: { ...TRIALS_SOURCE, address: cfg.trialsAddress },
    chain: chain.chainConfig,
    rpcUrl: cfg.rpcUrl,
    fromBlock: cfg.fromBlock ?? 0n,
    cursorFile: cfg.cursorFile,
    onError: (kind, detail) => console.error(`[scribe] ${kind}: ${detail}`),
  });

  // The bench is `DEFAULT_SANDBOX`: `allowLocalFallback: false`, so a host without a container
  // runtime does not quietly run the suite inside the seat's own container, next to its signing
  // key and its unopened salts. The re-run either happens in the isolated bench or it fails,
  // `Argus` reports `abstain`, and this seat casts nothing — which is the designed answer rather
  // than an outage wearing a mask.
  const verifier = new LiveVerifier({ content, sandboxSpec: { ...DEFAULT_SANDBOX, image: resolveVerifierImage() } });

  const cast = new DurableSeat({ poster: chain, state, seat: chain.seat });

  const index: IndexPort = {
    // The projection decides *where to look*; the chain decides what is true. Every candidate is
    // re-read through `getTrial`/`disputeOf` before a transaction is built, so an index that is
    // behind costs this pass a skipped trial and never a wrong vote.
    candidates: () => listTrials(scribe.state, "challenged").map((t) => t.id),
    votes: (trialId) => {
      const d = disputeState(scribe.state, trialId);
      return { committed: d.committed, revealed: d.revealed };
    },
  };

  const judge: JudgePort = {
    facts: async (trialId) => toRunFacts(await assembleChainFacts(chain, trialId), content),
    verify: (facts) => verifier.verify(facts),
  };

  const operator = createOperator({
    seat: chain.seat,
    constants,
    chain: { chainNow: () => chain.chainNow(), disputeView: (id, votes) => chain.disputeView(id, votes) },
    index,
    judge,
    cast,
    state,
    reverifyMs: cfg.reverifyMs,
    wallNow: () => Date.now(),
    log: (line) => console.log(`[juror] ${line}`),
  });

  const patrolBreaker = new CircuitBreaker({
    name: "juror.rpc",
    threshold: 3,
    windowMs: 60_000,
    cooldownMs: 30_000,
  });

  const flags = new Flags({
    source: envKillSwitches(),
    onError: (err) => console.error(`[juror] flag source failed: ${(err as Error).message}`),
  });

  const patrol = createPatrolLoop({
    intervalMs: cfg.patrolMs,
    flags,
    breaker: patrolBreaker,
    pass: () => operator.pass(),
    onLog: (line) => console.log(`[juror] ${line}`),
  });

  await scribe.sync();
  scribe.hydrate();
  void scribe.watch();
  await patrol.pass();
  patrol.handle.start();

  createServer(async (req, res) => {
    if (req.url === "/health") {
      const status = patrol.status();
      // Freshness has to be longer than the work, or the probe calls a working seat dead.
      //
      // `patrolMs * 4` alone is 120s at the compose default, while one verification can take the
      // sandbox's whole budget (`DEFAULT_SANDBOX.timeoutSec`, 900s) and `lastPassAt` is only stamped
      // when the pass returns. So a single open dispute would leave `/health` answering 503 for
      // fifteen minutes at a time — an operator watching a seat that is working, and a
      // `docker compose up --wait` that never becomes healthy. (Not a restart: compose does not
      // recreate a container for being unhealthy, whatever the comment in this file's first draft
      // claimed about it. The damage is a service that reports itself down while it is busy.)
      const budgetMs = marginSec * 1000 + cfg.patrolMs * 4;
      const fresh = status.lastPassAt !== null && Date.now() - status.lastPassAt < budgetMs;
      // Read off the durable store rather than the loop's memory: after a restart this is the
      // number that says whether the seat still holds votes it has to finish.
      const recovered = (await state.pending()).length;
      res.writeHead(fresh ? 200 : 503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: fresh,
          seat: chain.seat,
          granted,
          chainId: chain.chainId,
          trials: scribe.state.trials.size,
          challenged: listTrials(scribe.state, "challenged").length,
          indexedTo: Number(scribe.status.indexedTo),
          // Both of these are the index saying "I am not caught up or not complete", which for a
          // seat means "there may be seals I cannot count yet". A reveal gated on a lagging
          // index simply waits, so this is diagnostic rather than dangerous — but it has to be
          // readable, or a seat that has gone quiet looks identical to a chain that is idle.
          syncError: scribe.status.syncError,
          partialTrials: scribe.status.partialTrials,
          pendingSeals: recovered,
          lastPassAt: status.lastPassAt,
          lastPassConsidered: status.lastPassConsidered,
          lastPassActed: status.lastPassActed,
          lastPassAbstained: status.lastPassAbstained,
          // The difference between "nothing needed doing" and "an operator said stop".
          killed: status.killed,
          breakers: {
            [patrolBreaker.name]: status.breaker,
            [scribe.breaker.name]: scribe.breaker.status(),
          },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  }).listen(cfg.port, () => console.log(`[juror] health on :${cfg.port} — seat ${chain.seat}`));

  function shutdown(): void {
    // `stop()` on the handle rather than clearing a timer: what an operator is asking for is
    // that no further pass starts, which a cleared timer only promises for the next one.
    patrol.handle.stop();
    void flags.stop();
    scribe.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Run the service only when this file is the process's entry point — `node dist/main.js` in the
 * container, `tsx src/main.ts` under `npm run dev`. Importing the module then has no side
 * effects: no env is demanded, no node is dialled, no socket opens. Same guard and same
 * reasoning as `apps/keeper/src/main.ts`, including the Windows caveat — `argv[1]` may arrive
 * relative to the working directory, and the shell's separators do not agree with
 * `fileURLToPath`, so both sides are resolved before they are compared.
 */
const entry = process.argv[1];
if (entry && resolvePath(entry) === resolvePath(fileURLToPath(import.meta.url))) {
  await boot();
}
