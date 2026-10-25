"use client";

import { useCallback, useEffect, useState } from "react";
import { useFrenchy } from "@/lib/frenchy/provider";
import { fetchFrenchyBrainStatus } from "@/lib/frenchy/status";
import { guardPastedText, detectMnemonic, SEED_PHRASE_GUARANTEE } from "@/lib/safety";

/**
 * The two-way half of Frenchy: a visitor may speak, and the brain answers.
 *
 * `VoiceControl` is a loudspeaker — fixed lines, one click, no microphone. This is the
 * conversation, and it is deliberately the second control rather than the first: it renders
 * nothing until the API proves it has a brain, so a host configured for one-way speech does not
 * grow a button whose every sentence fails. The probe and the `ready`/`configured` pair are the
 * same shape `VoiceControl` uses, for the same reason — see `lib/frenchy/status.ts`.
 *
 * Two promises this component is responsible for, and neither is decoration:
 *
 *   * **Nothing is recorded before it is asked for.** The browser's microphone prompt fires on
 *     the first press of the listening button, not on page load. The header stays silent until
 *     someone leans in.
 *   * **A wallet backup is never accepted here.** The field refuses a pasted or typed
 *     seed-shaped phrase out loud and does not send it. The site has no use for one (the wallet
 *     signs; the API holds no key — ADR-0006), so a box that would take it is a box a phishing
 *     page can imitate. `SEED_PHRASE_GUARANTEE` is on screen permanently, in the chrome and at
 *     this gate, not only in this warning.
 *
 * Copy is written for a judge and a curious visitor, so it names no engines: no "TTS", no
 * "SpeechRecognition", no "LLM". A person deciding whether to speak to a page should be able to
 * read what the page said about itself.
 */

/** The one screen-reader-facing sentence per state, in the register the rest of the site uses. */
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

export function FrenchyAsk() {
  const { state, transcript, error, messages, enable, startListening, stopListening, sendText, mute, unmute, isMuted, cancel } =
    useFrenchy();

  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

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

  // Leaving the panel is leaving the conversation: an answer still being composed, or a clip
  // still playing, has to stop with it. Closing is not muting — the visitor may come back.
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
  const lastAnswer = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? null;

  return (
    <span className="wallet-inline">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-controls="frenchy-ask-panel"
        title="Ask Frenchy, the forge's AI host, by voice or in words."
      >
        {open ? "Close Frenchy (AI)" : "Ask Frenchy (AI)"}
      </button>

      {open ? (
        <div className="surface stack" id="frenchy-ask-panel" role="region" aria-label="Ask Frenchy">
          <span className="kicker">Frenchy (AI)</span>

          {/* The state is said in words, not drawn in colour: a visitor deciding whether to
              speak needs to know the page is actually listening, and a coloured dot says
              nothing to the person who cannot see it. */}
          <span role="status" aria-live="polite" className="mono">
            {state === "transcribing" && transcript ? `${STATE_LINE.transcribing} ${transcript}` : STATE_LINE[state] ?? STATE_LINE.idle}
          </span>

          <span className="wallet-inline">
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
          </span>

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
              aria-describedby="frenchy-ask-help"
            />
            <span id="frenchy-ask-help" className="hint hint--block">
              {SEED_PHRASE_GUARANTEE}
            </span>
          </label>

          <button type="button" className="btn btn-primary btn-sm" onClick={() => void ask()} disabled={draft.trim() === ""}>
            Ask
          </button>

          {refusal ? (
            <span className="mono" data-tone="sear" role="alert">
              {refusal}
            </span>
          ) : null}

          {error ? (
            <span className="mono" data-tone="sear" role="alert">
              {error}
            </span>
          ) : null}

          {lastAnswer ? <span className="hint hint--block">{lastAnswer}</span> : null}
        </div>
      ) : null}
    </span>
  );
}
