import Link from "next/link";
import { Chrome } from "@/components/Chrome";
import { siteIndex } from "@crucible/site-index";

/**
 * The Tour: every page of Crucible, and what it is for.
 *
 * This is the map the site index already is, shown to a person instead of to
 * the assistant. It is generated from the same descriptors Frenchy is grounded
 * in, so the two can never drift: a page that exists is on this list, and a
 * page that is on this list exists.
 *
 * It is a **server component** on purpose. A map of the site is data, and a
 * visitor who cannot run JavaScript should still be able to find the escrow
 * explorer.
 */

/** The pages that are a map of the site rather than a place to go. */
const MAP_PAGES = new Set(["/tour", "/compliance", "/docs"]);

export default function TourPage() {
  const places = siteIndex.filter((entry) => !MAP_PAGES.has(entry.path));

  return (
    <Chrome>
      <p className="kicker">Tour</p>
      <h1 className="page-title">Every page, and what it is for</h1>
      <p className="hint hint--block">
        {places.length} places. Each one says what it is for and what you can do there — the same
        words Frenchy is given, so the map you read and the map she acts on are the same map. Ask
        her to take you to any of them.
      </p>

      <ul className="tour">
        {places.map((entry) => (
          <li key={entry.path} className="surface detail-panel">
            <p className="kv">
              <span className="kv__key">Where</span>
              <Link href={entry.path} className="mono">
                {entry.path}
              </Link>
            </p>
            <p className="hint hint--block">{entry.purpose}</p>
            {entry.can.length > 0 ? (
              <p className="hint">
                You can: {entry.can.join("; ")}.
              </p>
            ) : null}
            {entry.needs ? <p className="hint">Needs: {entry.needs}.</p> : null}
            {entry.points && entry.points.length > 0 ? (
              <p className="hint">
                She can point at: <span className="mono">{entry.points.join(", ")}</span>
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="hint hint--block">
        The pages that are maps rather than places:{" "}
        <Link href="/docs" className="mono">
          /docs
        </Link>
        ,{" "}
        <Link href="/compliance" className="mono">
          /compliance
        </Link>
        , and this one.
      </p>
    </Chrome>
  );
}
