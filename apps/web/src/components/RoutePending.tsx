import { Chrome, Quenching } from "@/components/Chrome";

/**
 * The route-level fallback, shared by every page that reads.
 *
 * A `loading.tsx` in Next replaces the page segment while it resolves, so the navigation chrome
 * has to be put back by hand — a bare `Quenching` would flash a label on an empty screen and read
 * like a broken page rather than a slow one.
 *
 * `what` is phrased as a clause, not a noun, because it is the visible line: "reading the board
 * from the chain" tells a reader the number they are waiting for is being fetched rather than
 * computed here. That is the same claim the rest of the site makes about itself, and a loading
 * state that promises a number before the read has happened would be the first place on the site
 * that breaks it.
 */
export function RoutePending({ title, what }: { title: string; what: string }) {
  return (
    <Chrome>
      <h1 className="page-title">{title}</h1>
      <Quenching label={what} />
    </Chrome>
  );
}
