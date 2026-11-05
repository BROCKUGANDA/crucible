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

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true, hasScribe: !!scribe }));
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