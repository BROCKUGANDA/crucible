"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import {
  fetchVoiceClip,
  fetchVoiceStatus,
  localDay,
  markCatchphrase,
  markSpoken,
  prefetchVoiceClip,
  readVoicePrefs,
  shouldSpeak,
  subscribeVoice,
  verdictMoment,
  writeVoiceEnabled,
  type VoiceMoment,
} from "@/lib/voice";

/**
 * Frenchy's only visible surface.
 *
 * Off by default, one button to turn it on, and a Tour button once it is on. The
 * audio element lives here rather than in the page components because Chrome survives
 * route changes: a trial page announces a paid verdict, this control decides whether
 * the host is allowed to answer it.
 *
 * Failure is silence. A missing key, a dead provider, a browser that blocks autoplay —
 * all of them leave the page untouched. The voice never carries a fact the page needs.
 */
export function VoiceControl() {
  const reducedMotion = usePrefersReducedMotion();
  const [configured, setConfigured] = useState(false);
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const enabledRef = useRef(false);
  const reducedRef = useRef(false);
  const prefs = useRef<{ lastDay: string | null; catchphraseUsed: boolean }>({
    lastDay: null,
    catchphraseUsed: false,
  });
  const autoTried = useRef(false);

  enabledRef.current = enabled;
  reducedRef.current = reducedMotion;

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  // Silence is the right answer for speech nobody asked for. It is the wrong answer for the
  // click that asked: a button that says "on" while producing no sound is a lie about state.
  const fail = useCallback((reason: string, manual: boolean) => {
    console.warn(`[frenchy] ${reason}`);
    if (manual) setProblem(reason);
  }, []);

  const play = useCallback(
    async (moment: VoiceMoment, manual: boolean) => {
      const storage = typeof window === "undefined" ? null : window.localStorage;
      const today = localDay();
      if (
        !shouldSpeak({
          enabled: enabledRef.current,
          reducedMotion: reducedRef.current,
          lastDay: prefs.current.lastDay,
          today,
          manual,
        })
      ) {
        return;
      }

      const actual =
        moment === "verdict" || moment === "verdict-repeat"
          ? verdictMoment(prefs.current.catchphraseUsed)
          : moment;
      const clip = await fetchVoiceClip(actual);
      if (!clip.ok) {
        fail(clip.reason, manual);
        return;
      }
      stop();
      const url = URL.createObjectURL(clip.blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      urlRef.current = url;

      try {
        await audio.play();
      } catch (error) {
        // An autoplay refusal, a muted device, a codec the browser rejects, or a CSP that
        // will not load a blob: media source. All four look like "no sound" from outside.
        fail(error instanceof Error ? `${error.name}: ${error.message}` : String(error), manual);
        stop();
        return;
      }

      setProblem(null);
      if (storage) markSpoken(storage, today);
      prefs.current.lastDay = today;
      if (actual === "verdict" || actual === "verdict-repeat") {
        if (storage) markCatchphrase(storage);
        prefs.current.catchphraseUsed = true;
      }
    },
    [stop, fail],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = readVoicePrefs(window.localStorage);
    setEnabled(stored.enabled);
    enabledRef.current = stored.enabled;
    prefs.current = {
      lastDay: stored.lastDay,
      catchphraseUsed: stored.catchphraseUsed,
    };

    let alive = true;
    void fetchVoiceStatus().then((ok) => {
      if (!alive) return;
      setConfigured(ok);
      setReady(true);
    });

    return () => {
      alive = false;
      stop();
    };
  }, [stop]);

  // Warm the greeting as soon as the host is known to be on. Fetching is not playing, so
  // no autoplay policy is involved — but it means the return-visit greeting and the next
  // toggle both have the clip already, instead of waiting on a synthesis the tab does not
  // need to repeat. A failure is silence, like every other failure here.
  useEffect(() => {
    if (!ready || !configured || !enabled) return;
    void prefetchVoiceClip("greeting");
  }, [ready, configured, enabled]);

  // Return visits: if the host was left on, try one greeting for the day. The
  // browser may refuse without a gesture; a refused play is not marked as spoken,
  // so the next click can still produce it.
  useEffect(() => {
    if (!ready || !configured || !enabled || autoTried.current) return;
    autoTried.current = true;
    void play("greeting", false);
  }, [ready, configured, enabled, play]);

  useEffect(
    () =>
      subscribeVoice((moment) => {
        // Announced moments are automatic: once a day, not on reduced motion.
        void play(moment, false);
      }),
    [play],
  );

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    setProblem(null);
    enabledRef.current = next;
    if (typeof window !== "undefined") writeVoiceEnabled(window.localStorage, next);
    if (!next) {
      stop();
      return;
    }
    // The unmute click is the user gesture autoplay policies want. Suppress the
    // return-visit effect so this greeting cannot be played twice.
    autoTried.current = true;
    void play("greeting", true);
  }

  if (!ready || !configured) return null;

  const muteReason = enabled ? problem : null;

  return (
    <span className="wallet-inline voice-control">
      {/* "(AI)" is in the visible label, not only a tooltip: the person hearing a voice is
          the audience that disclosure is for, and a synthetic host that never says it is
          synthetic is the failure mode the provider's policy names. */}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-pressed={enabled}
        onClick={toggle}
        title={
          muteReason
            ? `Frenchy is an AI-generated voice, and he could not speak: ${muteReason}`
            : enabled
              ? "Frenchy is an AI-generated voice. He speaks a fixed welcome and tour, once a day at most. Turn him off."
              : "Unmute Frenchy, the forge's AI-generated voice host."
        }
      >
        {enabled ? (muteReason ? "Frenchy (AI) mute" : "Frenchy (AI) on") : "Frenchy (AI) off"}
      </button>
      {/* The reason is for the person debugging; the label change is for the person clicking. */}
      <span className="voice-note" role="status" aria-live="polite">
        {muteReason ? `Frenchy could not speak: ${muteReason}` : ""}
      </span>
      {enabled ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void play("tour", true)}
          title="Hear the thirty-second tour, in the AI voice"
        >
          Tour
        </button>
      ) : null}
    </span>
  );
}
