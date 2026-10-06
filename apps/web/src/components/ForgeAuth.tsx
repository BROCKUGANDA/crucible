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
 * still reads — a filled vessel is a filled vessel whether or not it moved.
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

      <style>{AUTH_CSS}</style>
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
            <stop offset="100%" stopColor="#2f6a63" />
          </linearGradient>
          <clipPath id="crucible-void">
            <path d="M32 48 h56 l-7 40 a8 8 0 0 1 -8 7 H47 a8 8 0 0 1 -8 -7 z" />
          </clipPath>
        </defs>

        {/* rising sparks, only on a fresh pour, and only once */}
        {fresh &&
          [0, 1, 2, 3].map((i) => (
            <circle
              key={i}
              className="crucible__spark"
              cx={52 + i * 6}
              cy={62}
              r={1.8}
              fill="var(--gold)"
              style={{ animationDelay: `${600 + i * 170}ms` }}
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

const AUTH_CSS = `
.forge-auth {
  min-height: 100svh;
  display: grid;
  place-items: center;
  padding: clamp(20px, 5vw, 48px);
  /* The foundry floor: heat rising from below the vessel, charcoal in every direction. */
  background:
    radial-gradient(60% 45% at 50% 82%, rgba(255,90,0,.22), transparent 70%),
    radial-gradient(90% 70% at 50% 12%, #170f0a 0%, #050302 72%);
}

.forge-auth__inner {
  width: 100%;
  max-width: 430px;
  text-align: center;
  display: grid;
  justify-items: center;
  gap: 0;
}

.forge-auth__title {
  font-size: clamp(1.7rem, 6vw, 2rem);
  font-weight: 800;
  margin: 22px 0 8px;
}

.forge-auth__sub {
  color: var(--dim);
  margin: 0;
  max-width: 34ch;
}

.forge-auth__gate {
  margin-top: 30px;
  width: 100%;
  display: grid;
  gap: 14px;
  justify-items: center;
}

.forge-auth__cta { width: min(300px, 100%); display: grid; }
.forge-auth__cta .btn { width: 100%; }

.forge-auth__chain { color: var(--faint); }

.forge-auth__switch {
  margin-top: 34px;
  font-size: .82rem;
  color: var(--ash);
}

.forge-auth__switch a { color: var(--gold); text-decoration: underline; text-underline-offset: 3px; }
.forge-auth__switch a:hover { color: var(--hot); }

/* Staged arrival: heat, then the words, then the way in. Each stage waits for the one
   before it rather than all three moving at once. */
.forge-auth [data-stage] {
  animation: forgeStage 560ms var(--ease-ignite) both;
}
.forge-auth [data-stage="1"] { animation-delay: 260ms; }
.forge-auth [data-stage="2"] { animation-delay: 400ms; }
.forge-auth [data-stage="3"] { animation-delay: 560ms; }
.forge-auth [data-stage="4"] { animation-delay: 760ms; }

@keyframes forgeStage {
  from { opacity: 0; transform: translateY(12px); filter: brightness(1.6); }
  to   { opacity: 1; transform: none; filter: none; }
}

.crucible {
  display: grid;
  place-items: center;
  width: 150px;
  height: 150px;
  border-radius: 26px;
  background: #0b0705;
  border: 1px solid rgba(255,90,0,.55);
  box-shadow: 0 0 46px rgba(255,90,0,.28), inset 0 0 30px rgba(0,0,0,.7);
  animation: crucibleBreathe 3.4s var(--ease-cool) infinite;
}

/* When the ingot sets, the vessel stops breathing. The heat has gone into the metal. */
.crucible[data-settled] { animation: none; border-color: var(--quench); box-shadow: 0 0 40px rgba(84,216,198,.22), inset 0 0 30px rgba(0,0,0,.7); }
.crucible[data-settled] .crucible__ember { fill: var(--quench); }
.crucible[data-settled] .crucible__wall { stroke: var(--quench); }

@keyframes crucibleBreathe {
  0%, 100% { transform: scale(1); box-shadow: 0 0 26px rgba(255,90,0,.2), inset 0 0 30px rgba(0,0,0,.7); }
  50%      { transform: scale(1.035); box-shadow: 0 0 58px rgba(255,90,0,.42), inset 0 0 30px rgba(0,0,0,.7); }
}

.crucible__mark { animation: markGlow 3.4s var(--ease-cool) infinite; transform-origin: 60px 30px; }
@keyframes markGlow {
  0%, 100% { opacity: .78; }
  50%      { opacity: 1; }
}

/* The pour is the metal level rising: a scaleY on the fill box, anchored at the bottom of
   the vessel. */
.crucible__metal--pour {
  transform-box: fill-box;
  transform-origin: bottom;
  animation: pourUp 1.5s var(--ease-ignite) both;
}

/* A returning operator sees an ingot already cast, coming back up to temperature. */
.crucible__metal--reheat {
  transform-box: fill-box;
  transform-origin: bottom;
  animation: reheat 2.6s var(--ease-cool) infinite;
}

@keyframes pourUp {
  from { transform: scaleY(0); }
  to   { transform: scaleY(1); }
}

@keyframes reheat {
  0%, 100% { opacity: .4; }
  50%      { opacity: 1; }
}

.crucible__ember { animation: emberBlink 3.4s var(--ease-cool) infinite; }
@keyframes emberBlink {
  0%, 100% { opacity: .6; }
  50%      { opacity: 1; }
}

.crucible__spark { animation: sparkRise 900ms var(--ease-cool) 1 both; }

@media (prefers-reduced-motion: reduce) {
  .crucible, .crucible__mark, .crucible__ember, .crucible__metal--reheat { animation: none; }
  .crucible__metal--pour { transform: scaleY(1); }
  .forge-auth [data-stage] { animation: none; }
  .crucible__spark { display: none; }
}
`;
