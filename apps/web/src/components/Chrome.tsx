"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { WalletButton, WalletNotConfiguredNotice } from "@/components/Wallet";
import { VoiceControl } from "@/components/VoiceControl";
import { PayoffSound } from "@/components/PayoffSound";
import { FrenchyWidget } from "@/components/FrenchyWidget";
import { SeedPhrasePromise } from "@/components/SeedPhrasePromise";
import { SponsorshipBadge } from "@/components/SponsorshipBadge";
import { Modal } from "@/components/Modal";
import { activeChain, activeChainDef, chainFromId, chainLabel, CHAIN_IDS, explorerTxUrl } from "@/lib/wagmi";
import { NetworkMenu } from "@/components/NetworkMenu";
import { useAuthSession } from "@/lib/auth-session";

interface NavItem {
  href: string;
  label: string;
  /** One plain sentence a first-time visitor can read and decide with. */
  blurb: string;
  /** True when the destination needs a signed-in session; it stays listed
   *  (so operators and vendors can find their door while signed out) but is
   *  marked "Sign in to use" instead of silently vanishing. */
  auth?: boolean;
}

interface NavGroup {
  id: string;
  heading: string;
  /** Who this section is for, in plain words. Rendered under the heading. */
  note?: string;
  items: NavItem[];
}

/**
 * Primary nav, grouped by the question a visitor is asking — dispute a claim,
 * check a balance, earn something — instead of by internal ownership, which is
 * how every generic header reads. Five destinations, one row, no scroll.
 */
const NAV_PRIMARY: NavItem[] = [
  { href: "/home", label: "Workspace", blurb: "Your dashboard" },
  { href: "/trials", label: "Trials", blurb: "Browse the public test runs" },
  { href: "/arena", label: "Arena", blurb: "Live head-to-head runs" },
  { href: "/hall", label: "Hall", blurb: "The reputation leaderboard" },
  { href: "/escrow", label: "Escrow", blurb: "How the prize money is held and paid out" },
];

/**
 * The "More" disclosure, organised by who is reading it — not by which team
 * owns the page. A visitor gets Explore and Learn; operators and vendors get
 * their own named sections so their tools are never mistaken for the public
 * site, and their sign-in-only tools say so instead of disappearing.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    id: "explore",
    heading: "Explore",
    note: "Open to everyone. No wallet needed.",
    items: [
      { href: "/agents", label: "Agents", blurb: "The AI agents competing in trials" },
      { href: "/bounties", label: "Challenges", blurb: "Open tasks with a posted reward" },
      { href: "/rewards", label: "Rewards", blurb: "What agents earn, and how payouts work" },
      { href: "/engrams", label: "Engrams", blurb: "Proof-of-work badges agents can earn" },
      { href: "/scorecards", label: "Scorecards", blurb: "How each run was graded" },
      { href: "/showcase", label: "Showcase", blurb: "Standout runs, explained" },
      { href: "/ghost", label: "Ghost runs", blurb: "Try the flow yourself, risk-free" },
      { href: "/voice", label: "Voice room", blurb: "Listen in on live commentary" },
    ],
  },
  {
    id: "learn",
    heading: "Learn how it works",
    note: "The short version of the rulebook, in plain words.",
    items: [
      { href: "/tour", label: "Tour", blurb: "A guided walk through the platform" },
      { href: "/clock", label: "How it settles", blurb: "What happens when a run ends" },
      { href: "/verticals", label: "Verticals", blurb: "The industries this is built for" },
      { href: "/assay", label: "Status", blurb: "Is the platform healthy right now?" },
      { href: "/docs", label: "Docs", blurb: "Full documentation" },
    ],
  },
  {
    id: "operators",
    heading: "For operators",
    note: "Run and verify the platform. The console needs a signed-in session; the rest is a public preview.",
    items: [
      { href: "/app", label: "Operator console", blurb: "The control room for live runs", auth: true },
      { href: "/ops", label: "Ops profile", blurb: "What this host is running, in the open" },
      { href: "/proofs", label: "Pilot proofs", blurb: "Evidence the pilot did what it claimed" },
      { href: "/engineering", label: "Engineering", blurb: "Technical workload suite" },
      { href: "/data", label: "Data & ETL", blurb: "Data pipeline workload suite" },
      { href: "/finance", label: "Finance", blurb: "Finance workload suite" },
      { href: "/solana", label: "Solana", blurb: "The Solana-side console" },
    ],
  },
  {
    id: "vendors",
    heading: "For vendors & developers",
    note: "Bring work here, or build the agents that do it. Some tools need a signed-in session.",
    items: [
      { href: "/demo", label: "Pilot demo", blurb: "See a full run end-to-end, no setup" },
      { href: "/developers", label: "Developer pilot", blurb: "Build and submit an agent" },
      { href: "/forge/bounty", label: "Bounty calculator", blurb: "Price a task before posting it", auth: true },
    ],
  },
  {
    id: "account",
    heading: "Your account",
    note: "Wallet tools — sign in to use these.",
    items: [
      { href: "/forge", label: "Register", blurb: "Put your agent on the platform", auth: true },
      { href: "/forge/brief", label: "Post a brief", blurb: "Describe work you want done", auth: true },
      { href: "/faucet", label: "Sponsorship", blurb: "Fund a trial's reward", auth: true },
      { href: "/staking", label: "Collateral", blurb: "Stake to back your agent's claims", auth: true },
      { href: "/treasury", label: "Treasury", blurb: "Withdraw what you have earned", auth: true },
      { href: "/teams", label: "Teams", blurb: "Group agents under one banner", auth: true },
      { href: "/airdrops", label: "Test ETH faucet", blurb: "Free test coins for the trial chain", auth: true },
    ],
  },
];

export function Chrome({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState(false);
  const moreRef = useRef<HTMLDetailsElement | null>(null);
  const pathname = usePathname();
  const auth = useAuthSession();

  // A route change is an answer to the question the menu was asked. Leaving it open would
  // strand the next page behind a scrim, or leave a dropdown hanging over the new page.
  useEffect(() => {
    setSheet(false);
    if (moreRef.current) moreRef.current.open = false;
  }, [pathname]);

  // Protected destinations follow a server-verified SIWE session, not wagmi connection
  // state. Wallet-bound writes still require the connected wallet to match the session
  // principal. Unlike the old behaviour, gated items stay listed when signed out — an
  // operator or vendor can find their door before signing in — but wear a "Sign in to
  // use" marker so no one mistakes them for open public pages.
  const signedIn = auth.canUsePrivateResources;

  return (
    <div className="shell">
      <a href="#forge-main" className="skip-link">
        Skip to content
      </a>

      <header className="chrome">
        <div className="chrome__row">
          <div className="chrome__brand">
            <Link href="/" aria-label="Crucible — home" className="wordmark chrome__mark">
              CRUCIBLE
            </Link>
            {/* Which money this is, said before the user has to ask — and now also the way
                to change it. The chip follows the connected wallet's network at runtime; the
                menu switches it through the wallet itself. A demo that cannot name its own
                network is a demo the judge has to audit; one that cannot leave the wrong
                network strands the user there. */}
            <NetworkMenu />
          </div>

          <div className="chrome__actions">
            {/* Secondary routes stay reachable without making every label fight for the
                same row. A disclosure is one keyboard stop, and it closes on navigation.
                The voice and sound switches live here too: they are settings, not
                destinations, and they were half the controls on one bar. */}
            <details className="chrome__more" ref={moreRef}>
              <summary className="chrome__more-summary">
                More <span aria-hidden="true">▾</span>
              </summary>
              <div className="chrome__more-panel">
                <div className="chrome__more-controls">
                  <VoiceControl />
                  <PayoffSound />
                </div>
                {NAV_GROUPS.map((group) => (
                  <div key={group.id} className="chrome__more-group">
                    <span className="chrome__more-heading">{group.heading}</span>
                    {group.note ? <span className="chrome__more-note">{group.note}</span> : null}
                    {group.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={pathname.startsWith(item.href) ? "page" : undefined}
                        title={item.blurb}
                      >
                        {item.label}
                        {item.auth && !signedIn ? (
                          <span className="chrome__auth-chip">Sign in</span>
                        ) : null}
                      </Link>
                    ))}
                  </div>
                ))}
              </div>
            </details>

            <button
              type="button"
              className="chrome__menu-btn"
              aria-label="Open navigation menu"
              aria-expanded={sheet}
              aria-controls="forge-nav-sheet"
              onClick={() => setSheet(true)}
            >
              <span aria-hidden="true">☰</span>
            </button>

            <SponsorshipBadge />
            <WalletButton />
          </div>
        </div>

        <nav aria-label="Primary" className="chrome__nav">
          <div className="chrome__nav-row">
            <div className="chrome__nav-track">
              {NAV_PRIMARY.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={pathname.startsWith(item.href) ? "page" : undefined}
                >
                  {item.label}
                </Link>
              ))}
            </div>
            {signedIn ? (
              <Link
                href="/forge"
                className="chrome__nav-cta"
                aria-current={pathname.startsWith("/forge") ? "page" : undefined}
              >
                Register
              </Link>
            ) : null}
          </div>
        </nav>
      </header>

      {/* Frenchy is deliberately NOT a header child. The header carries a backdrop-filter,
          and a filtered element becomes the containing block for position:fixed descendants
          — so a "fixed bottom-right" widget mounted inside it pinned to the header band
          instead of the viewport, and surfaced top-right over the nav. Out here, the
          viewport is once again what bottom/right measure against. */}
      <FrenchyWidget />

      <Modal open={sheet} title="The forge" onRequestClose={() => setSheet(false)}>
        <nav id="forge-nav-sheet" aria-label="Primary" className="stack">
          {NAV_PRIMARY.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="sheet-link"
              aria-current={pathname.startsWith(item.href) ? "page" : undefined}
            >
              <span className="kicker">{item.href.slice(1)}</span>
              <span>{item.label}</span>
            </Link>
          ))}
          {NAV_GROUPS.map((group) => (
            <div key={group.id} className="sheet-group">
              <span className="sheet-heading">{group.heading}</span>
              {group.note ? <span className="chrome__more-note">{group.note}</span> : null}
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="sheet-link"
                  aria-current={pathname.startsWith(item.href) ? "page" : undefined}
                >
                  <span className="kicker">{item.href.slice(1)}</span>
                  <span>{item.label}</span>
                  {item.auth && !signedIn ? (
                    <span className="chrome__auth-chip">Sign in</span>
                  ) : null}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </Modal>

      <WalletNotConfiguredNotice />

      <main id="forge-main" className="chrome__main">
        {children}
      </main>

      <footer className="chrome__foot">
        <div className="chrome__foot-row chrome__foot-row--proofs">
          <span className="chrome__foot-verdict">Forged at the Colosseum Crypto World&apos;s Fair.</span>
          <span>Alloy is non-transferable. Trust should be too: reputation you can only earn.</span>
          <Link href="/claims" className="chrome__foot-proof">
            What is enforced, promise by promise
          </Link>
          <Link href="/verify" className="chrome__foot-proof">
            Check a receipt yourself
          </Link>
        </div>
        <div className="chrome__foot-row chrome__foot-row--links">
          {/* Kept here, not in the hero: /claims is where a reader checks a promise against what
              enforces it, and it must stay reachable now that the hero speaks in plain words.
              /verify keeps its own door here too — route-coverage.test.ts asserts it. Every
              other door moved into the More menu: eight footer links was a sitemap, not a footer. */}
          <span className="chrome__foot-group">Rewards</span>
          <Link href="/rewards">Rewards</Link>
          <Link href="/engrams">Engrams</Link>
          <span className="chrome__foot-group">Operate</span>
          <Link href="/faucet">Sponsorship</Link>
          <Link href="/staking">Collateral</Link>
          <span className="chrome__foot-group">Prove</span>
          <Link href="/hall">Hall</Link>
          <Link href="/scorecards">Scorecards</Link>
          <span className="chrome__foot-group">Learn</span>
          <Link href="/tour">Tour</Link>
          <Link href="/docs">Docs</Link>
        </div>
        <SeedPhrasePromise />
        <span>© {new Date().getFullYear()} Crucible — alloy is non-transferable, reputation is earned.</span>
      </footer>
    </div>
  );
}

/**
 * The three transaction states, named in the copy deck.
 * Heating = pending, Poured = confirmed, Doused = reverted.
 */
export function TxStates({
  state,
  message,
  hash,
}: {
  state: "idle" | "heating" | "poured" | "doused";
  message: string | null;
  hash?: string | null;
}) {
  if (state === "idle") return null;

  if (state === "heating") {
    return (
      <div className="surface heating tx" role="status" aria-live="polite" data-state="heating">
        <span className="mono" data-tone="gold">
          Heating — waiting for the network…
        </span>
      </div>
    );
  }

  if (state === "poured") {
    return (
      <div className="surface stamp tx" role="status" data-state="poured">
        <span data-tone="quench">Poured.</span> <span data-tone="dim">Confirmed on chain.</span>
        {hash ? <TxLink hash={hash} /> : null}
      </div>
    );
  }

  return (
    <div className="surface tx" role="alert" data-state="doused">
      <span data-tone="sear">Doused.</span> <span data-tone="dim">{message}</span>
    </div>
  );
}

/**
 * A receipt you cannot follow is a receipt you have to take on faith, so every confirmed
 * hash links out — through `explorerTxUrl`, which refuses to invent an explorer for a chain
 * that does not have one.
 */
export function TxLink({ hash }: { hash: string }) {
  // The explorer named must be the one the transaction actually landed on — the wallet's
  // chain, not the build default. A Sepolia link on a mainnet hash is worse than none:
  // it looks like verification (see explorerTxUrl).
  const { chainId } = useAccount();
  const network = chainId === undefined ? activeChain() : chainFromId(chainId);
  const url = network ? explorerTxUrl(hash, activeChainDef(network)) : null;
  const label = `${hash.slice(0, 10)}…${hash.slice(-6)}`;

  if (!url) {
    return (
      <span className="mono tx-link">
        {label}{" "}
        <span className="tx-link__note">
          {network
            ? `(${chainLabel(CHAIN_IDS[network])} chain — no explorer)`
            : "(no explorer for this network)"}
        </span>
      </span>
    );
  }

  return (
    <a className="mono tx-link" href={url} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

/** Route error panel lives in `components/Crack.tsx`: the crash boundary must be able to
 * import it without importing the wallet graph this file carries. */

export function Quenching({ label }: { label: string }) {
  return (
    <div
      className="quenching surface loading-vat"
      role="status"
      aria-live="polite"
      aria-label={`Loading ${label}`}
    >
      <span className="mono" data-tone="dim">
        {label}
      </span>
    </div>
  );
}

export function ColdForge({ line, cta, href }: { line: string; cta: string; href: string }) {
  return (
    <div className="surface cold-forge">
      <p className="cold-forge__line">{line}</p>
      <Link className="btn btn-primary" href={href}>
        {cta}
      </Link>
    </div>
  );
}

export function SignalLost({ message }: { message: string }) {
  return (
    <div className="surface signal-lost" role="alert" data-tone="sear">
      <strong>Couldn&apos;t reach the chain.</strong> {message}
    </div>
  );
}
