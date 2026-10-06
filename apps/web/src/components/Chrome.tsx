"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { WalletButton, WalletNotConfiguredNotice } from "@/components/Wallet";
import { Modal } from "@/components/Modal";
import { activeChain, explorerTxUrl } from "@/lib/wagmi";

const NAV = [
  { href: "/trials", label: "Trials" },
  { href: "/agents", label: "Agents" },
  { href: "/forge", label: "Forge" },
  { href: "/bounties", label: "The Break" },
  { href: "/hall", label: "Hall" },
  { href: "/docs", label: "Docs" },
];

export function Chrome({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState(false);
  const pathname = usePathname();

  // A route change is an answer to the question the menu was asked. Leaving it open would
  // strand the next page behind a scrim.
  useEffect(() => setSheet(false), [pathname]);

  return (
    <div className="shell">
      <a href="#forge-main" className="skip-link">
        Skip to content
      </a>

      <header className="chrome">
        <Link href="/" aria-label="Crucible — home" className="wordmark chrome__mark">
          CRUCIBLE
        </Link>

        <div className="chrome__right">
          {/* The current page is stated in the markup, not only by colour: a route you
              cannot tell apart from the routes you can is a route you have not visited. */}
          <nav aria-label="Primary" className="chrome__nav">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={pathname.startsWith(item.href) ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <button
            type="button"
            className="btn btn-ghost btn-sm chrome__menu"
            onClick={() => setSheet(true)}
            aria-expanded={sheet}
            aria-controls="forge-nav-sheet"
          >
            Menu
          </button>
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
        <span>Alloy is non-transferable. Trust should be too.</span>
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
      <div className="surface heating" role="status" aria-live="polite" style={{ padding: 14 }}>
        <span className="mono" style={{ color: "var(--gold)" }}>
          Heating — waiting for the network…
        </span>
      </div>
    );
  }

  if (state === "poured") {
    return (
      <div className="surface stamp" role="status" style={{ padding: 14, borderColor: "var(--quench)" }}>
        <span style={{ color: "var(--quench)" }}>Poured.</span>{" "}
        <span style={{ color: "var(--dim)" }}>Confirmed on chain.</span>
        {hash ? <TxLink hash={hash} /> : null}
      </div>
    );
  }

  return (
    <div className="surface" role="alert" style={{ padding: 14, borderColor: "var(--sear)" }}>
      <span style={{ color: "var(--sear)" }}>Doused.</span>{" "}
      <span style={{ color: "var(--dim)" }}>{message}</span>
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
      <span className="mono" style={{ display: "block", color: "var(--dim)", marginTop: 6 }}>
        {label}{" "}
        <span style={{ color: "var(--faint)" }}>({activeChain()} chain — no explorer)</span>
      </span>
    );
  }

  return (
    <a
      className="mono"
      href={url}
      target="_blank"
      rel="noreferrer"
      style={{ display: "block", color: "var(--dim)", marginTop: 6, textDecoration: "underline", textUnderlineOffset: 3 }}
    >
      {label}
    </a>
  );
}

/** Route error boundary in the forge voice. Never a white screen. */
export function Crack({ message }: { message: string }) {
  return (
    <div className="surface" style={{ padding: 32, textAlign: "center" }}>
      <h2 style={{ color: "var(--sear)", marginTop: 0 }}>The crucible cracked.</h2>
      <p style={{ color: "var(--dim)" }}>
        Something broke on our side, not yours. The heat is contained.
      </p>
      <pre className="mono" style={{ color: "var(--faint)", whiteSpace: "pre-wrap" }}>
        {message}
      </pre>
      <button className="btn btn-primary" onClick={() => location.reload()}>
        Re-ignite
      </button>
    </div>
  );
}

export function Quenching({ label }: { label: string }) {
  return (
    <div
      className="quenching surface"
      style={{ height: 220, display: "grid", placeItems: "center" }}
      role="status"
      aria-live="polite"
      aria-label={`Loading ${label}`}
    >
      <span className="mono" style={{ color: "var(--dim)" }}>
        {label}
      </span>
    </div>
  );
}

export function ColdForge({ line, cta, href }: { line: string; cta: string; href: string }) {
  return (
    <div className="surface" style={{ padding: "clamp(24px, 6vw, 48px)", textAlign: "center", color: "var(--dim)" }}>
      <p style={{ fontSize: "1.1rem" }}>{line}</p>
      <Link className="btn btn-primary" href={href}>
        {cta}
      </Link>
    </div>
  );
}

export function SignalLost({ message }: { message: string }) {
  return (
    <div
      className="surface"
      role="alert"
      style={{ padding: 20, color: "var(--sear)", borderColor: "var(--sear)" }}
    >
      <strong>Signal lost.</strong> {message}
    </div>
  );
}
