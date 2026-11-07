"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount, useConnect, useSignMessage } from "wagmi";
import { WalletButton } from "@/components/Wallet";
import { SeedPhrasePromise } from "@/components/SeedPhrasePromise";
import { activeChain, chainFromId, gateMoneyNotice } from "@/lib/wagmi";
import { API_BASE } from "@/lib/apiBase";
import { useAuthSession } from "@/lib/auth-session";

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
  const sub = "Connect your wallet, then sign a free login message. Signing in does not send a transaction.";

  const { address, isConnected, chainId } = useAccount();
  const { isPending: connecting } = useConnect();
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const auth = useAuthSession();
  const money = gateMoneyNotice(chainId === undefined ? activeChain() : chainFromId(chainId));
  const [settled, setSettled] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.canUsePrivateResources) {
      setSettled(false);
      return;
    }
    const t = setTimeout(() => setSettled(true), 900);
    return () => clearTimeout(t);
  }, [auth.canUsePrivateResources]);

  async function authenticateWallet() {
    if (!address) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      const nonceResponse = await fetch(`${API_BASE}/auth/nonce`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ address }),
      });
      const challenge = (await nonceResponse.json().catch(() => null)) as
        | { message?: string; nonce?: string; error?: string; messageDetail?: string }
        | null;
      if (!nonceResponse.ok || !challenge?.message || !challenge.nonce) {
        throw new Error(challenge?.messageDetail ?? challenge?.error ?? `Could not start sign-in (${nonceResponse.status}).`);
      }

      // Sign the exact message returned by the server. This is authentication only,
      // not a blockchain transaction and not permission to move funds.
      const signature = await signMessageAsync({ message: challenge.message });
      const verifyResponse = await fetch(`${API_BASE}/auth/verify`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ address, nonce: challenge.nonce, signature }),
      });
      const verified = (await verifyResponse.json().catch(() => null)) as
        | { error?: string; message?: string }
        | null;
      if (!verifyResponse.ok) {
        throw new Error(verified?.message ?? verified?.error ?? `Sign-in failed (${verifyResponse.status}).`);
      }
      await auth.refresh();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Wallet authentication failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  return (
    <main className={`forge-auth ${fresh ? "forge-auth--pour" : "forge-auth--reheat"}`}>
      <div className="forge-auth__inner">
        <Crucible fresh={fresh} settled={settled} />

        <h1 className="forge-auth__title" data-stage="1">{headline}</h1>
        <p className="forge-auth__sub" data-stage="2">{sub}</p>

        <div className="forge-auth__gate" data-stage="3">
          {!isConnected ? (
            <div className="forge-auth__cta"><WalletButton /></div>
          ) : auth.canUsePrivateResources ? (
            <Link href="/forge" className="btn btn-primary forge-auth__cta">
              {settled ? "Step to the crucible" : "Ingot set…"}
            </Link>
          ) : (
            <button
              type="button"
              className="btn btn-primary forge-auth__cta"
              onClick={() => void authenticateWallet()}
              disabled={authBusy || signing}
            >
              {authBusy || signing ? "Verifying wallet…" : auth.isAuthenticated ? "Authenticate this wallet" : "Sign in with wallet"}
            </button>
          )}

          <span className="mono forge-auth__chain">
            {isConnected && address
              ? short(address)
              : connecting
                ? "opening your wallet…"
                : `running on ${activeChain()}`}
          </span>

          {auth.isAuthenticated && isConnected && !auth.walletMatches ? (
            <p className="hint" role="status">Your connected wallet differs from the wallet signed into Crucible. Sign in again with this wallet to continue.</p>
          ) : null}
          {authError ? <p className="hint" data-tone="sear" role="alert">{authError}</p> : null}

          <p className="forge-auth__demo" data-stage="3">
            <strong>{money.lead}</strong> {money.body} Your wallet is still your wallet:
            we ask it to sign, and we never hold a key for it.
          </p>
          <SeedPhrasePromise />
        </div>

        <p className="forge-auth__switch" data-stage="4">
          {fresh ? <>Already in? <Link href="/sign-in">Sign in</Link></> : <>First time? <Link href="/sign-up">Sign up</Link></>}
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
