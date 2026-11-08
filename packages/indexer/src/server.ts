#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";
import { Scribe } from "./scribe.js";
import { TRIALS_SOURCE } from "./scribe.js";
import { fetchTrialEvents } from "./trial-events.js";

const port = Number(process.env.INDEXER_PORT ?? 8791);
const host = process.env.INDEXER_HOST ?? "127.0.0.1";
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const trialsAddress = process.env.TRIALS_ADDRESS as `0x${string}`;
const fromBlock = process.env.FROM_BLOCK ? BigInt(process.env.FROM_BLOCK) : 0n;

const scribe = trialsAddress ? new Scribe({ source: { ...TRIALS_SOURCE, address: trialsAddress }, chain: foundry, rpcUrl, fromBlock, cursorFile: process.env.CRUSIBLE_CURSOR_FILE }) : null;

// Start canonical sync loop — without this, /health would report indexedTo=0 forever.
if (scribe) {
  scribe.watch?.().catch((err) => console.error("[indexer] watch failed:", err));
}

const app = new Hono();
/**
 * Liveness + how far the index reaches.
 *
 * A `200 ok:true` with zero trials is ambiguous: it is either a quiet chain or an
 * indexer that stopped listening, and an operator cannot tell which from this route.
 * The fields are the Scribe's own status — `indexedTo` tells how far the index
 * reaches, `head` how far the chain has gone, `syncError`/`syncStalled` why it may
 * have stopped. `ok` is false when the index stalled or errored, so a health check
 * (and an alert) acts on the indexer, not merely on process liveness.
 */
app.get("/health", (c) => {
  const st = scribe?.status;
  return c.json(
    {
      ok: !!scribe && st?.syncError === null && !st?.syncStalled,
      hasScribe: !!scribe,
      indexedTo: st ? st.indexedTo.toString() : null,
      head: st?.head?.toString() ?? null,
      headTimestamp: st?.headTimestamp ?? null,
      syncError: st?.syncError ?? null,
      syncStalled: st?.syncStalled ?? false,
      partialTrials: st?.partialTrials ?? 0,
    },
    scribe && st && (st.syncError !== null || st.syncStalled) ? 503 : 200,
  );
});
app.get("/indexer/trials/:id/events", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
  if (!scribe || !trialsAddress) return c.json({ error: "no trials address configured" }, 503);
  try {
    const events = await fetchTrialEvents({ rpcUrl, address: trialsAddress, trialId: id });
    return c.json({ trialId: id, indexedTo: scribe.status.indexedTo.toString(), events });
  } catch (err) {
    return c.json({ error: `indexer read failed: ${(err as Error).message}` }, 502);
  }
});

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[indexer] listening on http://${info.address}:${info.port}`);
});