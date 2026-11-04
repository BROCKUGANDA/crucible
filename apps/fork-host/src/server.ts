#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { createApp, port, host } from "./app.js";

serve({ fetch: createApp().fetch, port, hostname: host }, (info) => {
  console.log(`[fork-host] listening on http://${info.address}:${info.port}`);
});
