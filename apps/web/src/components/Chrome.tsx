"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { WalletButton, WalletNotConfiguredNotice } from "@/components/Wallet";

export function Chrome({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 32px",
          borderBottom: "1px solid var(--bg1)",
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        <Link href="/" aria-label="Crucible — home">
          <span className="wordmark" style={{ fontSize: 28 }}>
            CRUCIBLE
          </span>
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <nav aria-label="Primary" style={{ display: "flex", gap: 22, fontSize: 13.5 }}>
            <Link href="/trials">Trials</Link>
            <Link href="/agents">Agents</Link>
            <Link href="/forge">Forge</Link>
            <Link href="/bounties">The Break</Link>
            <Link href="/hall">Hall</Link>
            <Link href="/docs">Docs</Link>
          </nav>
          <WalletButton />
        </div>
      </header>

      <WalletNotConfiguredNotice />

      <main style={{ flex: 1, padding: "32px", maxWidth: 1180, width: "100%", margin: "0 auto" }}>
        {children}
      </main>

      <footer
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          padding: "24px 32px",
          borderTop: "1px solid var(--bg1)",
          fontSize: 12,
          color: "var(--faint)",
          flexWrap: "wrap",
        }}
      >
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
      <div
        className="surface"
        role="status"
        style={{ padding: 14, borderColor: "var(--quench)" }}
      >
        <span style={{ color: "var(--quench)" }}>Poured.</span>{" "}
        <span style={{ color: "var(--dim)" }}>Confirmed on chain.</span>
        {hash ? (
          <a
            className="mono"
            href={`https://sepolia.etherscan.io/tx/${hash}`}
            target="_blank"
            rel="noreferrer"
            style={{ display: "block", color: "var(--dim)", marginTop: 6 }}
          >
            {hash.slice(0, 10)}…{hash.slice(-6)}
          </a>
        ) : null}
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
    <div
      className="surface"
      style={{ padding: 48, textAlign: "center", color: "var(--dim)" }}
    >
      <p style={{ fontSize: 18 }}>{line}</p>
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
