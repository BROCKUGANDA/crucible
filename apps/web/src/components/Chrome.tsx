"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useReadContract } from "wagmi";
import { TRIALS_ABI } from "@crucible/smith";
import { WalletButton, WalletNotConfiguredNotice } from "@/components/Wallet";
import { VoiceControl } from "@/components/VoiceControl";
import { PayoffSound } from "@/components/PayoffSound";
import { FrenchyAsk } from "@/components/FrenchyAsk";
import { SeedPhrasePromise } from "@/components/SeedPhrasePromise";
import { Modal } from "@/components/Modal";
import { formatWei } from "@/lib/eth";
import { buildWithdraw, useTx } from "@/lib/useTx";
import { activeChain, deployment, environmentBadge, explorerTxUrl, ZERO_ADDRESS } from "@/lib/wagmi";

const NAV_PRIMARY = [
  { href: "/home", label: "Workspace" },
  { href: "/trials", label: "Trials" },
  { href: "/arena", label: "Arena" },
  { href: "/verticals", label: "Verticals" },
  { href: "/agents", label: "Agents" },
  { href: "/hall", label: "Hall" },
  { href: "/escrow", label: "Escrow" },
];

const NAV_MORE = [
  { href: "/forge", label: "Register" },
  { href: "/bounties", label: "Challenges" },
  { href: "/clock", label: "How it settles" },
  { href: "/assay", label: "Status" },
  { href: "/teams", label: "Teams" },
  { href: "/faucet", label: "Sponsorship" },
  { href: "/voice", label: "Voice room" },
  { href: "/airdrops", label: "Airdrops" },
  { href: "/staking", label: "Staking" },
  { href: "/engrams", label: "Engrams" },
  { href: "/tour", label: "Tour" },
  { href: "/docs", label: "Docs" },
];

const NAV = [...NAV_PRIMARY, ...NAV_MORE];

export function Chrome({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState(false);
  const moreRef = useRef<HTMLDetailsElement | null>(null);
  const pathname = usePathname();
  const env = environmentBadge();

  // A route change is an answer to the question the menu was asked. Leaving it open would
  // strand the next page behind a scrim, or leave a dropdown hanging over the new page.
  useEffect(() => {
    setSheet(false);
    if (moreRef.current) moreRef.current.open = false;
  }, [pathname]);

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
          {/* Which money this is, said before the user has to ask. A demo that cannot name its
              own network is a demo the judge has to audit. */}
          <span className="chip chrome__env chrome__env--wide" title={env.title}>
            {env.label}
          </span>
          <span className="chip chrome__env chrome__env--compact" title={env.title}>
            {env.compact}
          </span>
        </div>

        <div className="chrome__right">
          {/* The current page is stated in the markup, not only by colour: a route you
              cannot tell apart from the routes you can is a route you have not visited. */}
          <nav aria-label="Primary" className="chrome__nav">
            {NAV_PRIMARY.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname.startsWith(item.href) ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
            {/* Secondary routes stay reachable without making every label fight for the
                same row. A disclosure is one keyboard stop, and it closes on navigation. */}
            <details className="chrome__more" ref={moreRef}>
              <summary className="chrome__more-summary">
                More <span aria-hidden="true">▾</span>
              </summary>
              <div className="chrome__more-panel">
                {NAV_MORE.map((item) => (
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
          </nav>
          <button
            type="button"
            className="btn btn-ghost btn-sm chrome__menu"
            onClick={() => setSheet(true)}
            aria-label="Open navigation"
            aria-expanded={sheet}
            aria-controls="forge-nav-sheet"
          >
            <svg className="menu-glyph" viewBox="0 0 20 14" aria-hidden="true" focusable="false">
              <path d="M1 1h18M1 7h18M1 13h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span className="menu-label">Menu</span>
          </button>
          <VoiceControl />
          <PayoffSound />
          <FrenchyAsk />
          <CreditButton />
          <WalletButton />
        </div>
      </header>

      <Modal open={sheet} title="The forge" onRequestClose={() => setSheet(false)}>
        <nav id="forge-nav-sheet" aria-label="Primary" className="stack">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="sheet-link" aria-current={pathname.startsWith(item.href) ? "page" : undefined}>
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
        <SeedPhrasePromise />
      </footer>
    </div>
  );
}

/**
 * The contract pays through a pull ledger: settlement credits the operator, and the
 * only way the money leaves is `withdraw()`. Without this control the web app could
 * create, claim, and settle a trial but never hand the operator their ETH — a UI that
 * stops one call short of the payout.
 */
function CreditButton() {
  const { address } = useAccount();
  const dep = deployment();
  const { state, message, send, busy } = useTx();
  // Destructured so the dependency array names a binding, not a member
  // expression — `credit.refetch` in deps is stable in TanStack v5 but reads
  // as a lint finding; the bare `refetch` is the same stable function.
  const { data: creditData, refetch: refetchCredit } = useReadContract({
    abi: TRIALS_ABI,
    address: dep.trials,
    functionName: "credit",
    args: [address ?? ZERO_ADDRESS],
    query: { enabled: Boolean(address) && dep.configured },
  });

  useEffect(() => {
    if (state === "poured") void refetchCredit();
  }, [state, refetchCredit]);

  const amount = (creditData as bigint | undefined) ?? 0n;
  if (!address || amount === 0n) return null;

  return (
    <span className="wallet-inline">
      <button
        className="btn btn-ghost btn-sm"
        disabled={busy}
        onClick={() => send(buildWithdraw())}
        title="Withdraw everything credited to this wallet"
      >
        {busy ? "Withdrawing…" : `Withdraw ${formatWei(amount)} ETH`}
      </button>
      {state === "doused" ? (
        <span className="mono" data-tone="sear" role="alert">
          {message}
        </span>
      ) : null}
    </span>
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
  const url = explorerTxUrl(hash);
  const label = `${hash.slice(0, 10)}…${hash.slice(-6)}`;

  if (!url) {
    return (
      <span className="mono tx-link">
        {label}{" "}
        <span className="tx-link__note">({activeChain()} chain — no explorer)</span>
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
