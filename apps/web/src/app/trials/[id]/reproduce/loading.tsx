import { Chrome, Quenching } from "@/components/Chrome";

/**
 * The route-level fallback, in the same shape the page paints while it reads.
 *
 * A `loading.tsx` under a route renders inside the layout — and so inside the wallet and query
 * providers — which is why it may use `Chrome`. Only the root one has to import nothing that
 * touches the wallet.
 *
 * The bars are the reproduction's own shape: one line per binding the page will check, so the
 * layout does not jump when the real rows land. A skeleton is the shape of an answer, not a claim
 * about one — which matters more here than anywhere else on the site, because the page this one
 * stands in for is a verdict.
 */
export default function Loading() {
  return (
    <Chrome>
      <p className="kicker">Trial</p>
      <h1 className="page-title">Reproducing the run</h1>
      <Quenching label="reading the bytes, the signature and the report off the chain and the store…" />
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
