"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Chrome } from "@/components/Chrome";
import { API_BASE } from "@/lib/apiBase";

/**
 * The bytes a disclosed CID names, read in the page rather than in a raw tab.
 *
 * The API already answers every case correctly, and the distinction it draws
 * is worth keeping: content that is not pinned *here* is different from a
 * store that cannot be read, and different again from bytes that no longer
 * hash to the id they were served under. But the route returns **JSON for
 * every failure**, and a visitor who clicked a hash landed in a browser tab
 * showing `{"error":"the content store could not be read", ...}` with no
 * explanation, no way back, and a `reason` written for the log rather than
 * for a reader.
 *
 * So the bytes are fetched here and rendered as a **page**: the content when
 * it is there, and a plain explanation of which of the failures it was when
 * it is not. Nothing is guessed — every branch below maps one API answer to
 * one thing a reader can act on.
 */

type Phase =
  | { kind: "reading" }
  | { kind: "unreachable" }
  | { kind: "refused"; status: number; body: ContentError | null }
  | { kind: "bytes"; length: number }
  | { kind: "ready"; text: string };

/** The JSON body every failing `/content/:id` answer carries. */
interface ContentError {
  error?: string;
  id?: string;
  reason?: string;
  meaning?: string;
}

/** How much of a document is shown before it is truncated. */
const MAX_RENDERED_CHARS = 200_000;

/**
 * What the failure means for a reader, in one sentence.
 *
 * The API already sends a `meaning` for some cases and a `reason` for
 * others. This fills the gap with the same distinction the API draws, so
 * the page never has to invent one: *not here* is not *broken here*.
 */
function explain(error: ContentError | null, status: number): { title: string; body: string } {
  const reason = typeof error?.reason === "string" ? error.reason : undefined;
  const meaning = typeof error?.meaning === "string" ? error.meaning : undefined;
  switch (status) {
    case 404:
      return {
        title: "Nothing here names those bytes",
        body:
          meaning ??
          reason ??
          "This host does not hold the content. It may exist elsewhere - the CID is the address, and anyone holding the bytes can serve them.",
      };
    case 500:
      return {
        title: "The stored bytes do not hash to this CID",
        body:
          reason ??
          "The content is present but damaged: what was served under this id is not what the id names. That is a fault on this host, not a claim about the trial.",
      };
    case 503:
      return {
        title: "This host could not read its content store",
        body:
          reason ??
          "The store could not be opened, so nothing can be served from it. The trial's commitments are unaffected - the chain holds its own digests.",
      };
    default:
      return {
        title: "The content could not be read",
        body: reason ?? meaning ?? `The host answered ${status}.`,
      };
  }
}

export default function ContentPage() {
  const params = useParams<{ id: string }>();
  // A CID is `Qm.` or `ba.`; a trial's on-chain commitment is `0x` + 64 hex.
  // The API accepts both, and both are reachable from a trial page.
  const id = decodeURIComponent(params?.id ?? "");
  const [phase, setPhase] = useState<Phase>({ kind: "reading" });

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setPhase({ kind: "reading" });

    void (async () => {
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/content/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
      } catch {
        // The request itself dying is a different fact from the server
        // answering it badly, and the page says them differently.
        if (alive) setPhase({ kind: "unreachable" });
        return;
      }

      if (!res.ok) {
        let body: ContentError | null = null;
        try {
          body = (await res.json()) as ContentError;
        } catch {
          // A failure whose body is not JSON is still a failure; the status
          // is the fact the page can rely on.
        }
        if (alive) setPhase({ kind: "refused", status: res.status, body });
        return;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        // The route answers JSON for a failure, and a 200 with a JSON body is
        // a body this page does not render. Reading it as text is honest.
        const text = await res.text();
        if (alive) setPhase({ kind: "ready", text });
        return;
      }

      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      // The API hands back UTF-8 text when it decodes and raw bytes when it
      // does not, so the same check here tells the reader which they are
      // looking at.
      let text: string | null = null;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        text = null;
      }
      if (!alive) return;
      if (text !== null) {
        setPhase({ kind: "ready", text });
      } else {
        setPhase({ kind: "bytes", length: bytes.length });
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [id]);

  const truncated = useMemo(
    () => phase.kind === "ready" && phase.text.length > MAX_RENDERED_CHARS,
    [phase],
  );
  const shown = useMemo(
    () => (phase.kind === "ready" ? phase.text.slice(0, MAX_RENDERED_CHARS) : ""),
    [phase],
  );

  return (
    <Chrome>
      <p className="kicker">Disclosed content</p>
      <h1 className="page-title">{id || "No id"}</h1>
      <p className="hint hint--block">
        The bytes behind this commitment, as this host holds them. A CID names
        content by its bytes; a <span className="mono">0x</span> commitment is
        what the chain stored. Either way, what is served here is what the id
        names — and if this host cannot show it, that is said plainly rather
        than as an empty response.
      </p>

      {phase.kind === "reading" ? (
        <p className="hint hint--block">Reading…</p>
      ) : null}

      {phase.kind === "unreachable" ? (
        <div className="surface detail-panel">
          <p className="kv">
            <span className="kv__key">Outcome</span>
            <span className="badge badge--warning">host unreachable</span>
          </p>
          <p className="hint">
            The API did not answer. It may be starting, or the network between
            this page and it may be down. The content is unchanged either way.
          </p>
        </div>
      ) : null}

      {phase.kind === "refused" ? (
        <div className="surface detail-panel">
          <p className="kv">
            <span className="kv__key">Outcome</span>
            <span className="badge badge--warning">not available</span>
          </p>
          <p className="hint hint--block">
            {explain(phase.body, phase.status).title}
          </p>
          <p className="hint">{explain(phase.body, phase.status).body}</p>
          {phase.body?.reason ? (
            <p className="kv">
              <span className="kv__key">Host says</span>
              <span className="mono">{phase.body.reason}</span>
            </p>
          ) : null}
          <p className="hint">
            The trial&apos;s commitments do not depend on this host. The chain
            holds the digests, and any party holding the bytes can serve them.
          </p>
        </div>
      ) : null}

      {phase.kind === "bytes" ? (
        <div className="surface detail-panel">
          <p className="kv">
            <span className="kv__key">Outcome</span>
            <span className="badge badge--info">binary</span>
          </p>
          <p className="kv">
            <span className="kv__key">Size</span>
            <span className="mono">{phase.length.toLocaleString()} bytes</span>
          </p>
          <p className="hint hint--block">
            These bytes are not valid UTF-8, so they are not shown as text.
            Fetch them raw from{" "}
            <a href={`${API_BASE}/content/${encodeURIComponent(id)}`} className="mono">
              /content/{id}
            </a>
            .
          </p>
        </div>
      ) : null}

      {phase.kind === "ready" ? (
        <>
          <div className="surface detail-panel">
            <p className="kv">
              <span className="kv__key">Outcome</span>
              <span className="badge badge--success">read</span>
            </p>
            <p className="kv">
              <span className="kv__key">Size</span>
              <span className="mono">{phase.text.length.toLocaleString()} characters</span>
            </p>
            {truncated ? (
              <p className="hint hint--block">
                Shown truncated at {MAX_RENDERED_CHARS.toLocaleString()} characters. The
                raw bytes are at{" "}
                <a href={`${API_BASE}/content/${encodeURIComponent(id)}`} className="mono">
                  /content/{id}
                </a>
                .
              </p>
            ) : null}
          </div>
          <pre className="content-view">{shown}</pre>
        </>
      ) : null}
    </Chrome>
  );
}
