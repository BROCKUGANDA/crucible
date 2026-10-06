"use client";

import Link from "next/link";
import { WalletButton } from "@/components/Wallet";
import { activeChain } from "@/lib/wagmi";

/**
 * A deliberately non-generic entry gate.
 *
 * There is no username and no password to steal here — the wallet *is* the identity, so
 * a "sign in" page that asks for either would be theatre. What remains is a themed
 * moment that proves the door is live: a slow ember pulse over the forge mark, and the
 * real connect control below it.
 *
 * The pulse is pure CSS, runs in tandem with the wordmark and the tab indicator, and
 * respects `prefers-reduced-motion`. "Animated" does not have to mean "spinners
 * everywhere".
 */
export function ForgeAuth({ mode }: { mode: "sign-in" | "sign-up" }) {
  const signing = mode === "sign-up" ? "Enter the forge" : "Return to the forge";
  const sub = mode === "sign-up"
    ? "Connect your wallet to stake your first bond. There is no account, no password, no key you can lose."
    : "Connect your wallet to pick up where you left the forge.";

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(circle at 50% 30%, #1a0d05 0%, #050302 70%)",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 420, width: "100%", textAlign: "center" }}>
        <Ember />
        <h1 style={{ fontSize: 30, margin: "18px 0 8px", fontWeight: 800 }}>{signing}</h1>
        <p style={{ color: "var(--dim)", marginTop: 0 }}>{sub}</p>

        <div style={{ marginTop: 28, display: "grid", gap: 14 }}>
          <WalletButton />
          <span className="mono" style={{ color: "var(--faint)" }}>
            running on {activeChain()}
          </span>
        </div>

        <p style={{ color: "var(--ash)", marginTop: 30, fontSize: 13.5 }}>
          {mode === "sign-up" ? (
            <>Already in? <Link href="/sign-in">Sign in</Link></>
          ) : (
            <>First time? <Link href="/sign-up">Sign up</Link></>
          )}
        </p>
      </div>
    </div>
  );
}

/** A slow, decorated ember — the forge logo, breathing. */
function Ember() {
  return (
    <div
      aria-hidden
      style={{
        width: 74,
        height: 74,
        margin: "0 auto",
        borderRadius: 18,
        background: "#0b0705",
        border: "1px solid #ff5a00",
        display: "grid",
        placeItems: "center",
        boxShadow: "0 0 40px rgba(255,90,0,.35)",
        animation: "crucible-pulse 3.2s ease-in-out infinite",
      }}
    >
      <svg width="44" height="44" viewBox="0 0 64 64" fill="none">
        <path d="M32 12 12 46h8l12-26 12 26h8L32 12z" fill="#ff7a1a" />
        <circle cx="32" cy="44" r="4.5" fill="#ffc46b" />
      </svg>
      <style>{`
        @keyframes crucible-pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 24px rgba(255,90,0,.25); }
          50% { transform: scale(1.06); box-shadow: 0 0 56px rgba(255,90,0,.5); }
        }
        @media (prefers-reduced-motion: reduce) {
          [style*="crucible-pulse"] { animation: none !important; }
        }
      `}</style>
    </div>
  );
}