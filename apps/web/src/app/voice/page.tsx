"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Chrome } from "@/components/Chrome";
import { TurnMonitor } from "@/components/TurnMonitor";
import { API_BASE } from "@/lib/apiBase";
import {
  audioBlob,
  createStsRecorder,
  fetchStsStatus,
  openStsSession,
  readStsSession,
  sendStsTurn,
  type StsSession,
  type StsStatus,
  type StsTurn,
} from "@/lib/sts";
import { useAccount } from "wagmi";

/**
 * Frenchy, spoken.
 *
 * One button, one exchange at a time: press it, say something, press it again, and
 * the answer comes back in words and in voice. Beside it, the turn monitor reads
 * the conversation as it happens — which step the host is in, and what each step
 * cost.
 *
 * **The microphone belongs to this page alone.** Every other route in the product
 * keeps `microphone=()` in its Permissions-Policy, and only this one opens it to
 * itself. A page that can hear the room is a page that should ask first, and the
 * policy is what makes "this page only" a fact rather than an intention.
 *
 * **The words are the content.** If the host's voice fails, the answer is still on
 * screen and the panel says the voice failed. A missing garnish does not take the
 * meal with it.
 */

/** How often the monitor reads the host's phase while a turn is in flight. */
const PHASE_POLL_MS = 400;

type Phase = "idle" | "ready" | "recording" | "thinking" | "unavailable";

export default function VoicePage() {
  const { address, isConnected } = useAccount();
  const [status, setStatus] = useState<StsStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<StsSession | null>(null);
  const [turns, setTurns] = useState<StsTurn[]>([]);
  const [hostPhase, setHostPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<ReturnType<typeof createStsRecorder> | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The turn in flight, and the handle that supersedes it. */
  const inflight = useRef<AbortController | null>(null);

  /**
   * What the host can do.
   *
   * The probe is a GET, so it costs nothing and asks for no key. A host that
   * cannot answer is "unavailable", which is a different fact from "not
   * configured" — one is a fault and the other is a deployment decision.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const answer = await fetchStsStatus(API_BASE);
      if (!alive) return;
      if (!answer) {
        setPhase("unavailable");
        return;
      }
      setStatus(answer);
      setPhase(answer.configured ? "ready" : "idle");
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** Stop the phase poll, wherever it is running from. */
  const stopPolling = useCallback(() => {
    if (polling.current) {
      clearInterval(polling.current);
      polling.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopPolling();
      inflight.current?.abort();
      recorder.current?.stop();
    };
  }, [stopPolling]);

  /**
   * Read the host's phase while the turn runs.
   *
   * The panel shows the phase the host is actually in, which is why this polls
   * rather than guessing from a timer: a slow provider reads as a slow provider
   * and not as a client that lost track.
   */
  const startPolling = useCallback(
    (token: string) => {
      stopPolling();
      polling.current = setInterval(() => {
        void (async () => {
          const view = await readStsSession(API_BASE, token);
          if (!view) return;
          setHostPhase(view.phase);
          setTurns(view.turns);
        })();
      }, PHASE_POLL_MS);
    },
    [stopPolling],
  );

  async function beginRecording() {
    setError(null);

    // **A new turn supersedes the one in flight.** The visitor answered again, so
    // the answer to the previous words is not the answer they want: the request is
    // abandoned here and the host is told by the next turn.
    if (inflight.current) {
      inflight.current.abort();
      inflight.current = null;
      stopPolling();
    }

    if (!status?.configured) {
      setError("This host cannot speak yet: it has no transcription, no brain or no voice.");
      return;
    }

    let current = session;
    if (!current) {
      const opened = await openStsSession(API_BASE, { wallet: address ?? null });
      if (!opened) {
        setError("The host would not open a conversation. Nothing was recorded.");
        return;
      }
      current = opened;
      setSession(opened);
    }

    if (!recorder.current) recorder.current = createStsRecorder();
    const started = await recorder.current.start();
    if (!started) {
      setError("The microphone was not available. Nothing was recorded.");
      return;
    }
    setPhase("recording");
  }

  async function sendRecording() {
    const current = recorder.current;
    if (!current) return;
    if (!session) return;

    const blob = await current.stop();
    setPhase("thinking");
    if (!blob) {
      setError("Nothing was recorded, so there was nothing to send.");
      setPhase("ready");
      return;
    }

    const controller = new AbortController();
    inflight.current = controller;
    startPolling(session.token);
    const result = await sendStsTurn(API_BASE, session.token, blob, { signal: controller.signal });
    stopPolling();
    if (inflight.current === controller) inflight.current = null;

    if (!result) {
      setError("The host did not answer. The turn was not recorded.");
      setPhase("ready");
      return;
    }

    if (result.interrupted) {
      // Superseded by a newer turn: there is no answer to show, and the panel
      // says so rather than showing silence.
      setTurns(result.turns);
      setHostPhase("idle");
      setError("That turn was superseded — Frenchy was already answering something else.");
      setPhase("ready");
      return;
    }

    setTurns(result.turns);
    setHostPhase(result.phase);

    // The words are the content. A voice that failed is named, not swallowed.
    if (result.voiceError) {
      setError(`Frenchy answered in words, but the voice failed: ${result.voiceError}`);
    }

    const playable = audioBlob(result);
    if (playable) {
      const url = URL.createObjectURL(playable);
      const player = new Audio(url);
      audio.current = player;
      player.onended = () => URL.revokeObjectURL(url);
      await player.play().catch(() => {
        // A browser that will not play without a gesture is a browser that will
        // not play; the words are on the screen either way.
      });
    }

    setPhase("ready");
  }

  const recording = phase === "recording";
  const busy = phase === "thinking";

  return (
    <Chrome>
      <p className="kicker">Frenchy, spoken</p>
      <h1 className="page-title">The voice room</h1>
      <p className="hint hint--block">
        Press the button, say something, press it again. Frenchy answers in words
        and in voice, and the monitor beside this reads the conversation turn by
        turn. The microphone is used only while you are recording, and only on
        this page.
      </p>

      {phase === "unavailable" ? (
        <p className="hint hint--block" role="status">
          This host did not answer. That is a fact about the host, not a sign that
          the feature is missing.
        </p>
      ) : null}

      {status && !status.configured ? (
        <p className="hint hint--block" role="status">
          This host is not configured to speak yet.
          {status.stt ? null : " It has no transcription."}
          {status.brain ? null : " It has no brain."}
          {status.tts ? null : " It has no voice."}
        </p>
      ) : null}

      <div className="surface detail-panel" id="voice-room">
        <p className="kv">
          <span className="kv__key">Transcription</span>
          <span>{status?.stt ? (status.model ?? "on") : "—"}</span>
        </p>
        <p className="kv">
          <span className="kv__key">Brain</span>
          <span>{status?.brain ? "on" : "—"}</span>
        </p>
        <p className="kv">
          <span className="kv__key">Voice</span>
          <span>{status?.tts ? "on" : "—"}</span>
        </p>
        <p className="kv">
          <span className="kv__key">Wallet</span>
          <span className="mono">{isConnected && address ? address : "not connected"}</span>
        </p>

        <div className="engram-actions">
          {recording ? (
            <button className="btn btn-primary" type="button" onClick={() => void sendRecording()}>
              Send it
            </button>
          ) : (
            <button
              className="btn btn-primary"
              type="button"
              disabled={!status?.configured}
              onClick={() => void beginRecording()}
              title={
                busy
                  ? "Answer again — this supersedes the turn Frenchy is still on."
                  : "Your browser will ask for the microphone before anything is recorded."
              }
            >
              {busy ? "Answer again" : "Talk to Frenchy"}
            </button>
          )}
        </div>
        {busy ? (
          <p className="hint" role="status">
            Frenchy is thinking. Answer again to supersede this turn.
          </p>
        ) : null}
        {recording ? (
          <p className="hint" role="status">
            Recording. Press “Send it” when you are done.
          </p>
        ) : null}
      </div>

      <TurnMonitor turns={turns} phase={hostPhase} error={error} />
    </Chrome>
  );
}
