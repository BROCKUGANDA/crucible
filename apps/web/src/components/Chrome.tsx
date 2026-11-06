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

interface NavItem {
  href: string;
  label: string;
  auth?: boolean;
}

const NAV_PRIMARY: NavItem[] = [
  { href: "/home", label: "Workspace" },
  { href: "/trials", label: "Trials" },
  { href: "/arena", label: "Arena" },
  { href: "/verticals", label: "Verticals" },
  { href: "/agents", label: "Agents" },
  { href: "/hall", label: "Hall" },
  { href: "/escrow", label: "Escrow" },
];

const NAV_MORE: NavItem[] = [
  { href: "/forge", label: "Register", auth: true },
  { href: "/forge/brief", label: "Forge Brief", auth: true },
  { href: "/forge/bounty", label: "Bounty Calculator", auth: true },
  { href: "/bounties", label: "Challenges" },
  { href: "/clock", label: "How it settles" },
  { href: "/assay", label: "Status" },
  { href: "/teams", label: "Teams", auth: true },
  { href: "/faucet", label: "Sponsorship", auth: true },
  { href: "/voice", label: "Voice room" },
  { href: "/airdrops", label: "Airdrops", auth: true },
  { href: "/staking", label: "Staking", auth: true },
  { href: "/treasury", label: "Treasury", auth: true },
  { href: "/engrams", label: "Engrams" },
  { href: "/tour", label: "Tour" },
  { href: "/docs", label: "Docs" },
  { href: "/scorecards", label: "Scorecards" },
];

export function Chrome({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState(false);
  const moreRef = useRef<HTMLDetailsElement | null>(null);
  const pathname = usePathname();
  const { address } = useAccount();
  const isConnected = Boolean(address);

  // A route change is an answer to the question the menu was asked. Leaving it open would
  // strand the next page behind a scrim, or leave a dropdown hanging over the new page.
  useEffect(() => {
    setSheet(false);
    if (moreRef.current) moreRef.current.open = false;
  }, [pathname]);

  // Auth-gated nav items: only show when connected
  const visiblePrimary = NAV_PRIMARY.filter((item) => !item.auth || isConnected);
  const visibleMore = NAV_MORE.filter((item) => !item.auth || isConnected);
  const visibleNav = [...visiblePrimary, ...visibleMore];

  return (
    <div className="shell">
      <a href="#forge-main" className="skip-link">
        Skip to content
      </a>

      <header className="chrome">
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
         <nav aria-label="Primary" className="chrome__nav">
           <div className="chrome__nav-track">
             {visiblePrimary.map((item) => (
               <Link
                 key={item.href}
                 href={item.href}
                 aria-current={pathname.startsWith(item.href) ? "page" : undefined}
               >
                 {item.label}
               </Link>
             ))}
           </div>
         </nav>

        <div className="chrome__actions">
          {/* Secondary routes stay reachable without making every label fight for the
              same row. A disclosure is one keyboard stop, and it closes on navigation. */}
          <details className="chrome__more" ref={moreRef}>
            <summary className="chrome__more-summary">
              More <span aria-hidden="true">▾</span>
            </summary>
            <div className="chrome__more-panel">
              {visibleMore.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={pathname.startsWith(item.href) ? "page" : undefined}
                >
                  {item.label}
                </Link>
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

          <VoiceControl />
          <PayoffSound />
          <SponsorshipBadge />
          <WalletButton />
        </div>
      </header>

      {/* Frenchy is deliberately NOT a header child. The header carries a backdrop-filter,
          and a filtered element becomes the containing block for position:fixed descendants
          — so a "fixed bottom-right" widget mounted inside it pinned to the header band
          instead of the viewport, and surfaced top-right over the nav. Out here, the
          viewport is once again what bottom/right measure against. */}
      <FrenchyWidget />

      <Modal open={sheet} title="The forge" onRequestClose={() => setSheet(false)}>
        <nav id="forge-nav-sheet" aria-label="Primary" className="stack">
          {visibleNav.map((item) => (
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
        </nav>
      </Modal>

      <WalletNotConfiguredNotice />

      <main id="forge-main" className="chrome__main">
        {children}
      </main>

      <footer className="chrome__foot">
        <span>Forged at the Colosseum Crypto World&apos;s Fair.</span>
        <span>Alloy is non-transferable. Trust should be too: reputation you can only earn.</span>
        {/* Kept here, not in the hero: /claims is where a reader checks a promise against what
            enforces it, and it must stay reachable now that the hero speaks in plain words. */}
        <Link href="/claims">What is enforced, promise by promise</Link>
        {/* The receipt checker had no door: it existed, the sitemap listed it, and no page
            linked to it — so the one artifact an integrator is told to check could only be
            reached by guessing the URL. It belongs beside the promise list, in the same
            plain words, because both answer "can I check this myself?". */}
        <Link href="/verify">Check a receipt yourself</Link>
        {/* Orphan routes — pages exist but had no inbound link, so a visitor could only reach
            them by guessing the URL. Each door below is the page's own job title in plain
            words, matching how /claims and /verify are linked. /trials stays as an alias
            beside the nav so a reader scanning the footer still finds the board. */}
        <Link href="/ghost">Start a ghost run on a fork</Link>
        <Link href="/showcase">House bouts on screen</Link>
        <Link href="/trials">Trials board</Link>
        <SeedPhrasePromise />
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

/** Route error boundary in the forge voice. Never a white screen. */
export function Crack({ message }: { message: string }) {
  return (
    <div className="surface void-panel">
      <h2 className="void-panel__title" data-tone="sear">
        The crucible cracked.
      </h2>
      <p className="void-panel__body">
        Something broke on our side, not yours. The heat is contained.
      </p>
      <pre className="mono void-panel__trace">{message}</pre>
      <button className="btn btn-primary" onClick={() => location.reload()}>
        Re-ignite
      </button>
    </div>
  );
}

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
