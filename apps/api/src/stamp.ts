/**
 * @file stamp.ts — STAMP protocol-ownership domain entry point.
 *
 * STAMP = Simple Token Agreement — Market Protected. It is a private investment
 * agreement that bridges private capital to a MetaDAO-governed Solana token
 * launch, not an SDK and not a reward mechanism for trials. This module is the
 * API's door into that domain; the domain itself lives in `./stamp/`.
 *
 * The structure is deliberate and follows the blueprint's separation:
 *
 *   - `./stamp/store.ts`   three ledgers (legal, cash, chain) that reconcile
 *                          but are never written by one statement
 *   - `./stamp/mode.ts`    `STAMP_MODE` and the fail-closed production manifest
 *   - `./stamp/routes.ts`  the admin, investor and public surfaces
 *   - `@crucible/stamp-core`   pure integer maths: allocations, vesting, the
 *                          Pacific calendar, the four state machines, the gates
 *   - `@crucible/stamp-solana` read-only chain observation and the MetaDAO
 *                          adapter whose only shipped mode is manual
 *
 * What this module keeps is the surface the rest of the API already imports:
 * the mode resolution, the pure calculators (re-exported so existing callers and
 * tests keep working) and the route factory.
 *
 * STAMP does NOT replace the Treasury/Owner Safes. Custody remains a multisig,
 * and this process holds no chain key.
 */

export { createStampRoutes } from "./stamp/routes.js";
export type { StampConfig } from "./stamp/routes.js";
export { resolveMode as stampMode, evaluateProductionGate, productionGate } from "./stamp/mode.js";
export type { StampMode } from "./stamp/mode.js";
export {
  __resetStampForTests,
  __resetStampStoreForTests,
  __stampModelForTests,
} from "./stamp/state.js";

/**
 * The pure calculators, re-exported.
 *
 * They live in `@crucible/stamp-core` now; these names are kept because the
 * existing suite and the console import them, and because a caller that only
 * needs arithmetic should not have to know where the domain lives.
 */
export { holderPortion, ratableReduce } from "@crucible/stamp-core";
export { monthlyReleaseVector as monthlyReleases } from "@crucible/stamp-core";