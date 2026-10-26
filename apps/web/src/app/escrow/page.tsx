"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Chrome } from "@/components/Chrome";
import { checkAddressTarget } from "@/lib/safety";
import { deployment } from "@/lib/wagmi";
import { useAccount } from "wagmi";

/**
 * The escrow explorer's door (gate 838).
 *
 * It asks for an address and nothing else. This is a read: no signature, no spending approval, no
 * seed phrase — and the page says so, because a visitor who has been burned elsewhere will look
 * for the trap. The address is checked here rather than at the destination so a typo comes back as
 * "that is not an address" instead of a 404 with a number on it.
 */
export default function EscrowLandingPage() {
  const router = useRouter();
  const { address, isConnected, chainId } = useAccount();
  const dep = deployment();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  const check = checkAddressTarget({ value, connectedChainId: chainId, expectedChainId: dep.chainId });

  function go(target: string) {
    setTouched(true);
    const resolved = checkAddressTarget({
      value: target,
      connectedChainId: chainId,
      expectedChainId: dep.chainId,
    });
    if (!resolved.ok || !resolved.address) return;
    router.push(`/escrow/${resolved.address.toLowerCase()}`);
  }

  return (
    <Chrome>
      <p className="kicker">Where is my ETH</p>
      <h1 className="page-title">The escrow, by address</h1>
      <p className="hint hint--block">
        Enter an address to see what the escrow contract is holding for it: the reward it funded,
        the bond it posted as an agent, the stake it put on a break, and what it can already
        withdraw. This is a read. It asks for no signature and never asks for a seed phrase.
      </p>

      <label className="field">
        <span>Address</span>
        <input
          type="text"
          inputMode="text"
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="0x…"
        />
      </label>

      {touched && !check.ok ? (
        <ul className="hint hint--block" role="alert">
          {check.problems.map((p) => (
            <li key={`${p.check}-${p.message}`}>{p.message}</li>
          ))}
        </ul>
      ) : null}

      <div className="escrow-actions">
        <button type="button" className="btn btn-primary" onClick={() => go(value)}>
          Read the escrow
        </button>
        {isConnected && address ? (
          <button type="button" className="btn" onClick={() => go(address)}>
            Use the connected wallet
          </button>
        ) : null}
      </div>

      <p className="clock-prose">
        Settled money is never pushed to a wallet — the contract credits a ledger and the owner
        withdraws it, so an address can be owed ETH and still show nothing in its balance.{" "}
        <Link href="/clock">How a trial settles</Link>.
      </p>
    </Chrome>
  );
}
