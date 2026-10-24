import { Chrome, Quenching } from "@/components/Chrome";

/**
 * The route-level fallback, in the same shape the page paints while it reads.
 *
 * A `loading.tsx` under a route renders inside the layout — and so inside the wallet and query
 * providers — which is why it may use `Chrome`. Only the *root* `loading.tsx` has to import nothing
 * that touches the wallet (see `app/loading.tsx`); this one is never the no-providers document.
 *
 * The bars are `aria-hidden` and sit inside the same `Chrome` as the sentence, so nothing lands
 * outside the main landmark. A skeleton is the shape of an answer, not a claim about one: the line
 * `Quenching` prints is what a reader is actually told, and it names what is being read rather than
 * promising a number that has not arrived.
 */
export default function Loading() {
  return (
    <Chrome>
      <p className="kicker">Trial</p>
      <h1 className="page-title">The replay</h1>
      <Quenching label="reading this trial's beats off the chain…" />
      <div className="stack" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="row">
            <span className="skeleton assay-skel assay-skel--key" />
            <span className="skeleton assay-skel" />
            <span className="skeleton assay-skel" />
          </div>
        ))}
      </div>
    </Chrome>
  );
}
