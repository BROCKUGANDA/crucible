"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount, useConnect } from "wagmi";
import { WalletButton } from "@/components/Wallet";
import { activeChain } from "@/lib/wagmi";

/**
 * The entry gate, and the only page in the app that is allowed to be theatre.
 *
 * There is no username and no password to steal here — the wallet *is* the identity, so a
 * "sign in" page that asked for either would be a lie. What the page can honestly show is
 * the state of the forge, so that is what it animates: two different thermal stories from
 * one motion library.
 *
 *   sign up    a fresh pour. The crucible is cold, metal arrives and fills it, sparks fly
 *              once as the ingot sets.
 *   sign in    re-heating. The ingot is already there and cold; heat comes back up through
 *              it and the ember re-ignites.
 *
 * Both are CSS-driven and both stop dead under prefers-reduced-motion, where every state
 * still reads — a filled vessel is a filled vessel whether or not it moved. The styles for
 * this screen live in console.css and its keyframes in motion.css.
 */
export function ForgeAuth({ mode }: { mode: "sign-in" | "sign-up" }) {
  const fresh = mode === "sign-up";
  const headline = fresh ? "Enter the forge" : "Return to the forge";
  const sub = fresh
    ? "Connect your wallet to stake your first bond. There is no account, no password, no key you can lose."
    : "Connect your wallet to pick up where you left the forge.";

  const { address, isConnected } = useAccount();
  const { isPending } = useConnect();

  // The gate has to *do* something once it is passed, or it is a splash screen wearing a
  // button. Connected means connected — say so, and hand over the way in.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!isConnected) {
      setSettled(false);
      return;
    }
    const t = setTimeout(() => setSettled(true), 900);
    return () => clearTimeout(t);
  }, [isConnected]);

  return (
    <main className={`forge-auth ${fresh ? "forge-auth--pour" : "forge-auth--reheat"}`}>
      <div className="forge-auth__inner">
        <Crucible fresh={fresh} settled={settled} />

        <h1 className="forge-auth__title" data-stage="1">
          {headline}
        </h1>
        <p className="forge-auth__sub" data-stage="2">
          {sub}
        </p>

        <div className="forge-auth__gate" data-stage="3">
          {isConnected ? (
            <Link href="/forge" className="btn btn-primary forge-auth__cta">
              {settled ? "Step to the crucible" : "Ingot set…"}
            </Link>
          ) : (
            <div className="forge-auth__cta">
              <WalletButton />
            </div>
          )}
          <span className="mono forge-auth__chain">
            {isConnected && address
              ? short(address)
              : isPending
                ? "opening your wallet…"
                : `running on ${activeChain()}`}
          </span>
        </div>

        <p className="forge-auth__switch" data-stage="4">
          {fresh ? (
            <>
              Already in? <Link href="/sign-in">Sign in</Link>
            </>
          ) : (
            <>
              First time? <Link href="/sign-up">Sign up</Link>
            </>
          )}
        </p>
      </div>
    </main>
  );
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * The vessel, drawn rather than photographed: a crucible seen from the side, the metal in
 * it, and the ember dot that is the same mark the favicon carries.
 */
function Crucible({ fresh, settled }: { fresh: boolean; settled: boolean }) {
  return (
    <div className="crucible" aria-hidden data-settled={settled || undefined}>
      <svg viewBox="0 0 120 120" width="118" height="118">
        <defs>
          {/* A paint server, not a CSS gradient: an SVG rect can only be filled by the
              former, and the molten band is the point of the whole animation. */}
          <linearGradient id="molten" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--ember)" />
            <stop offset="55%" stopColor="var(--gold)" />
            <stop offset="100%" stopColor="var(--hot)" />
          </linearGradient>
          <linearGradient id="quenched" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--quench)" />
            <stop offset="100%" stopColor="color-mix(in srgb, var(--quench) 55%, var(--bg0))" />
          </linearGradient>
          <clipPath id="crucible-void">
            <path d="M32 48 h56 l-7 40 a8 8 0 0 1 -8 7 H47 a8 8 0 0 1 -8 -7 z" />
          </clipPath>
        </defs>

        {/* rising sparks, only on a fresh pour, and only once; the per-spark delays are
            cut in console.css, not inline, so the choreography stays in the motion layer */}
        {fresh &&
          [0, 1, 2, 3].map((i) => (
            <circle
              key={i}
              className={`crucible__spark crucible__spark--${i + 1}`}
              cx={52 + i * 6}
              cy={62}
              r={1.8}
              fill="var(--gold)"
            />
          ))}

        {/* the metal: clipped to the vessel, level rising by transform */}
        <g clipPath="url(#crucible-void)">
          <rect
            className={`crucible__metal ${fresh ? "crucible__metal--pour" : "crucible__metal--reheat"}`}
            x="30"
            y="46"
            width="60"
            height="52"
            fill={settled ? "url(#quenched)" : "url(#molten)"}
          />
        </g>

        {/* the vessel, drawn over the metal so the meniscus reads as inside it */}
        <path
          d="M30 46 h60 l-8 44 a10 10 0 0 1 -10 8 h-24 a10 10 0 0 1 -10 -8 z"
          fill="none"
          stroke="var(--ember)"
          strokeWidth="2.5"
          strokeLinejoin="round"
          className="crucible__wall"
        />

        {/* the mark */}
        <path d="M60 18 44 42h6l10-17 10 17h6L60 18z" fill="var(--ember)" className="crucible__mark" />
        <circle cx="60" cy="37" r="3.2" fill="var(--gold)" className="crucible__ember" />
      </svg>
    </div>
  );
}
