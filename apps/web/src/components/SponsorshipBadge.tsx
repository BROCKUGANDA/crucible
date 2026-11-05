"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { API_BASE } from "@/lib/apiBase";
import { readApplications } from "@/lib/sponsorship";

/**
 * The owner's notification that someone applied for sponsorship.
 *
 * It is the answer to "make sure I get a notification": the webhook reaches
 * the owner out of band, and this badge reaches them while they are anywhere
 * else on the site. It only appears for the wallet that owns the queue - a
 * visitor who is not the owner is never told that somebody else applied, and a
 * visitor who is the owner is never left to open the faucet page to find out.
 *
 * It polls rather than streams, because a sponsorship queue is not worth a
 * websocket, and fifteen seconds is short enough to feel like a notification
 * and long enough not to be noise.
 */

const POLL_MS = 15_000;

export function SponsorshipBadge() {
  const { address } = useAccount();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!address) {
      setCount(null);
      return;
    }

    let alive = true;
    let controller: AbortController | null = null;

    const load = async () => {
      controller?.abort();
      const c = new AbortController();
      controller = c;
      try {
        const res = await fetch(`${API_BASE}/faucet/applications?wallet=${address}`, {
          signal: c.signal,
        });
        if (!alive || !res.ok) return;
        const body = await res.json().catch(() => null);
        const applications = readApplications(body);
        if (!alive || applications === null) return;
        setCount(applications.length);
      } catch {
        // A poll that fails is a host that did not answer. The badge is not
        // shown rather than showing "0", because zero is a measurement and
        // "could not ask" is not one.
        if (alive) setCount(null);
      }
    };

    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      controller?.abort();
      clearInterval(timer);
    };
  }, [address]);

  if (count === null || count === 0) return null;

  return (
    <Link
      href="/faucet"
      className="chip chrome__badge"
      title={`${count} sponsorship request${count === 1 ? "" : "s"} waiting for you`}
      aria-label={`${count} sponsorship request${count === 1 ? "" : "s"} waiting for you`}
    >
      <span className="mono">{count}</span>
    </Link>
  );
}
