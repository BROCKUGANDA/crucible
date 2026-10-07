"use client";

import Link from "next/link";
import { Chrome, ColdForge, Quenching, SignalLost } from "@/components/Chrome";
import { useSnapshot } from "@/lib/useSnapshot";
import { TrialTable } from "@/components/TrialTable";

/**
 * The live trial ticker on the landing page. A separate client component so the
 * rest of the page stays server-rendered and prerenders without the API.
 */
export function LiveFeedInner() {
  const { data, error, loading, serverNowMs } = useSnapshot();

  if (loading) return <Quenching label="quenching trials…" />;
  if (error) return <SignalLost message={error} />;

  if (data && data.trials.length === 0) {
    return (
      <ColdForge
        line="Cold forge. No trials burning yet."
        cta="Light the first one"
        href="/trials/new"
      />
    );
  }

  if (!data) {
    return (
      <div className="surface feed-fallback">
        <p>
          <Link href="/trials" data-tone="ember">
            See every trial
          </Link>{" "}
          — or light the first one.
        </p>
      </div>
    );
  }

  return <TrialTable trials={data.trials.slice(0, 5)} serverNowMs={serverNowMs} />;
}
