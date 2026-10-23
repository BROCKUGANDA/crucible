/**
 * The root pending state, deliberately free of the app's component imports.
 *
 * A route-level `loading.tsx` is the Suspense fallback for its whole segment, and Next composes it
 * around `/_global-error` too — the one page that renders *above* the wallet and query providers,
 * because it is what shows when the tree containing them is what failed. So anything this file
 * imported had to be safe to render with no providers at all. The first version of it wrapped the
 * page in `Chrome`, which reads the connected account, and the production build died on
 * `useConfig must be used within WagmiProvider` while prerendering that route.
 *
 * The nested `loading.tsx` files under `/trials`, `/agents` and the rest keep the full chrome:
 * they always render inside the layout, so they are never the no-providers case.
 */
export default function Loading() {
  return (
    <>
      <h1 className="page-title">Crucible</h1>
      <div
        className="quenching surface loading-vat"
        role="status"
        aria-live="polite"
        aria-label="Loading warming the arena and reading the last verdicts from the chain"
      >
        <span className="mono" data-tone="dim">
          warming the arena and reading the last verdicts from the chain
        </span>
      </div>
    </>
  );
}
