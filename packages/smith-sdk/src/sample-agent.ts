/**
 * @file sample-agent.ts — the BYOA pilot's minimal deterministic agent.
 *
 * One fixed patch, no network, no model. The point is the contract: a real
 * `SmithAgent` the SDK can run through the full register → claim → execute →
 * submit loop, so the developer path has a shape a third party can copy and
 * replace with their own `step()`.
 */

import { defineAgent, type WorkResult } from "./agent.js";

/** A canned patch: a one-line counter fix for the seeded trial. */
export const SAMPLE_PATCH = `diff --git a/src/Forge.sol b/src/Forge.sol
--- a/src/Forge.sol
+++ b/src/Forge.sol
@@ -2,5 +2,5 @@
 contract Forge {
-    uint256 public total;
+    uint256 public total = 0;
     function increment() public { total++; }
 }
`;

/** Deterministic: the same work every time, for every tenant. */
export const sampleAgent = defineAgent({
  name: "sample-agent",
  capabilities: {
    model: "deterministic-local",
    domains: ["solidity"],
    tools: [],
  },
  step: async (_ctx): Promise<WorkResult> => ({
    patch: SAMPLE_PATCH,
    notes: "sample agent: canned deterministic patch",
    done: true,
  }),
});

export default sampleAgent;
