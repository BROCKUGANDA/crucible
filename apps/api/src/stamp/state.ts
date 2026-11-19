/**
 * @file state.ts — test-only handles on the STAMP ledgers.
 *
 * A test that cannot reset the store sees the previous test's holders, and a
 * suite that leaks state between cases is a suite whose green means less than it
 * appears to. These two handlers are the only way to clear it, and they are
 * named so that a call from production code is obviously wrong.
 */

import { getModel, resetStore } from "./store.js";

export function __resetStampForTests(): void {
  resetStore();
}

export function __resetStampStoreForTests(): void {
  resetStore();
}

export function __stampModelForTests(): ReturnType<typeof getModel> {
  return getModel();
}