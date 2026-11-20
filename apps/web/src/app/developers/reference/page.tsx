"use client";

import Link from "next/link";
import { Chrome, SignalLost } from "@/components/Chrome";
import { useContract, rateLimitInWords } from "@/lib/useContract";

/**
 * The API reference, written by the API.
 *
 * Every rule on this page is fetched from `/v1/contract` — the pagination
 * rules, the rate limit, the authentication schemes, the webhook signature
 * and the error catalogue. None of them are typed here, because a typed copy
 * is a copy that goes stale the first time the limiter's numbers change.
 *
 * So the page can be wrong in exactly one way: if the host cannot be
 * reached. When that happens it says so, in those words, rather than
 * rendering an empty error list that reads like "your request will never
 * fail".
 */
export default function DeveloperReferencePage() {
  const state = useContract();

  return (
    <Chrome>
      <p className="kicker">Developer portal — the API, as it is</p>
      <h1 className="page-title" id="reference-panel">Reference</h1>
      <p className="lede">
        Every rule below was read from the running API a moment ago. If the API
        changes, this page changes with it — there is no second copy to fall
        out of date.
      </p>

      {state.kind === "loading" ? (
        <p className="hint hint--block">Reading the API&apos;s own description of itself…</p>
      ) : null}

      {state.kind === "unreachable" ? (
        <SignalLost
          what="the host"
          message={`The API could not be reached, so no reference could be read. (${state.reason})`}
        />
      ) : null}

      {state.kind === "refused" ? (
        <SignalLost what="the host" message={`The API did not return a reference. ${state.reason}`} />
      ) : null}

      {state.kind === "ready" ? <Contract contract={state.contract} /> : null}

      <p className="hint hint--block">
        Back to <Link className="mono" href="/developers">the five-minute path</Link>.
      </p>
    </Chrome>
  );
}

function Contract({ contract }: { contract: import("@/lib/useContract").ApiContract }) {
  return (
    <>
      <h2 className="section-title">Signing in</h2>
      <ul className="stack">
        {contract.authentication.schemes.map((scheme) => (
          <li key={scheme.name} className="surface detail-panel">
            <p>
              <strong>{scheme.name}</strong>
            </p>
            <p className="hint">{scheme.how}</p>
            <p className="hint">Use it for: {scheme.use}</p>
          </li>
        ))}
      </ul>
      <ul className="stack">
        {contract.authentication.rules.map((rule) => (
          <li key={rule} className="hint">
            {rule}
          </li>
        ))}
      </ul>

      <h2 className="section-title">Pages and limits</h2>
      <p className="surface detail-panel">
        <strong>Rate limit</strong> — {rateLimitInWords(contract.rateLimit)},{" "}
        {contract.rateLimit.scope}. {contract.rateLimit.body}
      </p>
      <p className="surface detail-panel">
        <strong>Reading a list</strong> — {contract.pagination.rule}
        <br />
        <br />
        {contract.pagination.parameters.map((parameter) => (
          <span key={parameter.name}>
            <span className="mono">{parameter.name}</span> — {parameter.meaning}
            <br />
          </span>
        ))}
        {contract.pagination.response.map((field) => (
          <span key={field.name}>
            <span className="mono">{field.name}</span> — {field.meaning}
            <br />
          </span>
        ))}
      </p>

      <h2 className="section-title">Webhooks</h2>
      <p className="surface detail-panel">
        {contract.webhooks.signing} {contract.webhooks.replayWindow}
        <br />
        <br />
        {contract.webhooks.headers.map((header) => (
          <span key={header.name}>
            <span className="mono">{header.name}</span> — {header.meaning}
            <br />
          </span>
        ))}
      </p>

      <h2 className="section-title">When something goes wrong</h2>
      <p className="hint hint--block">
        Every refusal carries a machine-readable <span className="mono">code</span> and a
        sentence explaining it. The code is the stable part; the sentence is for people.
      </p>
      <div className="stack">
        {contract.errors.map((entry) => (
          <div key={entry.code} className="surface detail-panel">
            <p>
              <span className="mono">{entry.code}</span>{" "}
              <span className="hint">— HTTP {entry.status}</span>
            </p>
            <p className="hint">{entry.meaning}</p>
            <p className="hint">What to do: {entry.whatToDo}</p>
          </div>
        ))}
      </div>
    </>
  );
}
