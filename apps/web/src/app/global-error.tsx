"use client";

import { Crack } from "@/components/Chrome";

/**
 * The boundary nothing else can be the boundary for.
 *
 * `error.tsx` catches a fault inside a route. It cannot catch a fault in the tree that *contains*
 * it — the providers, the font loading, the `<html>` element — and Next's fallback for that case is
 * an empty document, which on this site is indistinguishable from a server that is down. The
 * component has to render its own `html` and `body` because the layout that would have supplied
 * them is the thing that failed.
 *
 * Two paths, measured by faulting each one on purpose and reading the response:
 *
 *   - A fault during the *server* render of the root layout: Next answers with its own
 *     `id="__next_error__"` document. This component is not in it, so nothing here can make that
 *     page prettier or leak a stack through it.
 *   - A fault during the *client* render inside the providers: the browser already has the
 *     document and the layout stylesheets, and this boundary replaces the tree. So the design
 *     system is available without importing any CSS here — measured in a browser, the panel comes
 *     up on the forge surfaces (bg `rgb(21, 18, 16)`, title `rgb(207, 65, 50)`) with three
 *     stylesheets attached.
 *
 * One thing that genuinely does not carry over: the self-hosted faces. `next/font` puts its
 * variables on the `<html>` className that the layout owns, and this page replaces the layout, so
 * type falls back to the stacks `tokens.css` declares for each face — a serif for the roman face,
 * `system-ui` for the display face. Attaching the real classes here would mean importing `layout`
 * into the boundary that exists to catch `layout` failing, and `next/font` is not supported in a
 * client component anyway. A crash page set in Georgia still reads as this site; one that imports
 * the tree it is meant to survive does not read at all.
 *
 * Note what is deliberately absent: `error.message` is not printed here. The route-level boundary
 * already shows it, and this one sits above the providers, so the failures that reach it are the
 * ones that can carry a module path, a bundled URL or a wallet library's internal string. A judge
 * does not need that and a stranger should not get it — the console still has it, because the
 * browser logs an uncaught render error regardless of what this page chooses to display.
 *
 * No retry handler is wired either. `reset` re-renders the failed segment, and the segment that
 * failed here is the one holding the providers, so the only honest recovery is a fresh document —
 * which is what `Crack`'s own button does.
 */
export default function GlobalError() {
  return (
    <html lang="en">
      <body>
        <Crack message="The forge itself faulted. Check your wallet or transaction history before retrying — an action you started may already have been submitted." />
      </body>
    </html>
  );
}
