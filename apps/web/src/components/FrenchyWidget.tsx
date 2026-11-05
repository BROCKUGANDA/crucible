"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useFrenchy } from "@/lib/frenchy/provider";
import { fetchFrenchyBrainStatus } from "@/lib/frenchy/status";
import { guardPastedText, detectMnemonic, SEED_PHRASE_GUARANTEE } from "@/lib/safety";

/**
 * Frenchy (AI) as a side-chat widget.
 *
 * A floating trigger sits at the bottom-right edge of every page. Opening it reveals a
 * side panel that is a full conversation: the visitor speaks or types, the brain answers,
 * and the premium voice reads the answer back. The panel survives route changes because
 * Chrome — where this is mounted — is the layout wrapper.
 *
 * Every behaviour contract the header panel honoured is kept here:
 *
 *   * Nothing is recorded before it is asked for — the microphone prompt fires on the
 *     first press of Listen, never on page load.
 *   * A wallet backup is never accepted here — the field refuses a seed-shaped phrase
 *     aloud and does not send it.
 *   * Nothing is claimed that is not configured — the widget renders nothing until the
 *     API proves it has a brain (503 on empty POST → not shown).
 *   * A figure is read or it is not shown — unknown renders nothing; silence is not a
 *     fabricated answer.
 *
 * The mouth and the screen stay separate: the spoken line is three sentences the voice
 * can carry; the detail is the depth, written where it can be read and kept.
 */

const STATE_LINE: Record<string, string> = {
  idle: "Nothing is being recorded.",
  prompt: "Press listen, and your browser will ask first.",
  granted: "Ready.",
  listening: "Listening…",
  transcribing: "Heard you say:",
  thinking: "Thinking…",
  speaking: "Speaking…",
  denied: "Your browser has the microphone switched off for this site.",
  unavailable: "This browser cannot listen, so type instead.",
};

export function FrenchyWidget() {
  const {
    state,
    transcript,
    messages,
    error,
    enable,
    startListening,
    stopListening,
    sendText,
    speak,
    mute,
    unmute,
    isMuted,
    cancel,
  } = useFrenchy();

  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Keep the transcript in view while it is being spoken so a visitor can read what
  // is being captured as it arrives.
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, transcript]);

  useEffect(() => {
    let alive = true;
    void fetchFrenchyBrainStatus().then((ok) => {
      if (!alive) return;
      setConfigured(ok);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const close = useCallback(() => {
    cancel();
    setOpen(false);
  }, [cancel]);

  /** The paste guard. Refuses the phrase and says why; the text never reaches the field. */
  function onPaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData?.getData("text") ?? "";
    const decision = guardPastedText(text);
    if (!decision.refuse) return;
    event.preventDefault();
    setRefusal(decision.warning);
  }

  async function ask() {
    const text = draft.trim();
    if (!text) return;
    // Typed, not pasted, is the same phrase — the guard reads the content, not the clipboard.
    const hit = detectMnemonic(text);
    if (hit) {
      setRefusal(
        `That reads like a ${hit.wordCount}-word wallet backup, so it was not sent. ${SEED_PHRASE_GUARANTEE}`,
      );
      return;
    }
    setRefusal(null);
    setDraft("");
    await sendText(text);
  }

  if (!ready || !configured) return null;

  const canListen = state !== "unavailable";
  const listening = state === "listening";

  return (
    <div className="frenchy-widget" role="region" aria-label="Ask Frenchy (AI)">
      {/* Floating trigger: always present when the panel is closed. */}
      {!open && (
        <button
          type="button"
          className="frenchy-widget__trigger"
          onClick={() => setOpen(true)}
          aria-label="Open Ask Frenchy (AI) chat"
          title="Ask Frenchy (AI) — speak or type"
        >
          <span className="frenchy-widget__icon" aria-hidden="true">
            ✦
          </span>
          <span className="frenchy-widget__label">Ask Frenchy</span>
        </button>
      )}

      {/* Backdrop that dismisses the panel on a click outside. */}
      {open && (
        <div
          className="frenchy-widget__backdrop"
          onClick={close}
          aria-hidden="true"
        />
      )}

      {/* Side panel: slides in from the right edge. */}
      {open && (
        <div className="frenchy-widget__panel">
          <div className="frenchy-widget__head">
            <span className="kicker">Frenchy (AI)</span>
            <button
              type="button"
              className="frenchy-widget__close"
              onClick={close}
              aria-label="Close Frenchy chat"
            >
              ✕
            </button>
          </div>

          {/* Status is read in words, not drawn in colour: a visitor deciding whether to
              speak needs to know the page is actually listening. */}
          <span
            role="status"
            aria-live="polite"
            className="frenchy-widget__status mono"
          >
            {state === "transcribing" && transcript ? transcript : STATE_LINE[state] ?? STATE_LINE.idle}
          </span>

          <div className="frenchy-widget__controls">
            {canListen ? (
              listening ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={stopListening}>
                  Stop listening
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => (state === "granted" ? startListening() : void enable())}
                  title="Your browser will ask for the microphone before anything is recorded."
                >
                  Listen
                </button>
              )
            ) : null}

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => (isMuted ? unmute() : mute())}
              aria-pressed={isMuted}
              title={isMuted ? "Let Frenchy answer again." : "Silence him, including an answer already on its way."}
            >
              {isMuted ? "Unmute" : "Mute"}
            </button>
          </div>

          <label className="field">
            <span className="kicker">Or ask in words</span>
            <input
              className="input mono"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onPaste={onPaste}
              onKeyDown={(event) => {
                if (event.key === "Enter") void ask();
              }}
              placeholder="Which trials are still open?"
              aria-describedby="frenchy-widget-help"
            />
            <span id="frenchy-widget-help" className="hint hint--block">
              {SEED_PHRASE_GUARANTEE}
            </span>
          </label>

          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void ask()}
            disabled={draft.trim() === ""}
          >
            Ask
          </button>

          {refusal ? (
            <span className="mono" data-tone="sear" role="alert">{refusal}</span>
          ) : null}

          {error ? (
            <span className="mono" data-tone="sear" role="alert">{error}</span>
          ) : null}

          {/* Conversation: the assistant's spoken line plus the depth she did not say out loud. */}
          <div className="frenchy-widget__messages" ref={messagesEndRef}>
            {messages.map((m, i) => (
              <div
                key={i}
                className={`frenchy-widget__message frenchy-widget__message--${m.role}`}
              >
                {m.role === "assistant" ? (
                  <>
                    <span className="frenchy-widget__message-content">{m.content}</span>
                    {m.detail ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void speak(m.detail!)}
                          title="Read the detail out loud."
                        >
                          Read it to me
                        </button>
                        <div className="frenchy-widget__detail">
                          <span className="kicker">In detail</span>
                          <span className="frenchy-widget__detail-body">{m.detail}</span>
                        </div>
                      </>
                    ) : null}
                    {m.action ? (
                      <span className="hint" role="status">
                        {m.action.kind === "point"
                          ? `Pointing at ${m.action.why || m.action.point}.`
                          : `Taking you to ${m.action.path}.`}
                      </span>
                    ) : null}
                    {m.offered ? (
                      <span className="hint" role="status">
                        {m.offered.kind === "point"
                          ? `I can point at ${m.offered.point} on ${m.offered.path}, once your wallet is free.`
                          : `I can take you to ${m.offered.path}, once your wallet is free.`}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="frenchy-widget__message-content">{m.content}</span>
                )}
              </div>
            ))}
            {messages.length === 0 && (
              <div className="frenchy-widget__empty">
                <span className="faint">Nothing said yet. Press Listen or type a question.</span>
              </div>
            )}
          </div>

          {/* The voice room is the same brain and the same voice, and it is the one that
              keeps the conversation: this panel transcribes in the browser and writes
              nothing down, while the voice room transcribes on the host and records every
              turn with what each step cost. */}
          <Link href="/voice" className="hint">
            Take it to the voice room, where the conversation is written down
          </Link>
        </div>
      )}
    </div>
  );
}

export default FrenchyWidget;
