"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAccount } from "wagmi";
import { API_BASE } from "@/lib/apiBase";
import { cancelUtterance, teardownFrenchy, type MediaTrack } from "./teardown";
import { createScribeTranscriber } from "./scribe-transcriber";

export type FrenchyState =
  | "idle"
  | "prompt"
  | "granted"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "denied"
  | "unavailable";

export interface FrenchyMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface FrenchyContextValue {
  state: FrenchyState;
  transcript: string;
  messages: FrenchyMessage[];
  error: string | null;
  enable: () => Promise<void>;
  startListening: () => void;
  stopListening: () => void;
  sendText: (text: string) => Promise<void>;
  dismissError: () => void;
  /** stop this answer without changing the visitor's mute preference */
  cancel: () => void;
  mute: () => void;
  unmute: () => void;
  isMuted: boolean;
}

const FrenchyContext = createContext<FrenchyContextValue | null>(null);

export function useFrenchy(): FrenchyContextValue {
  const ctx = useContext(FrenchyContext);
  if (!ctx) throw new Error("useFrenchy must be used within FrenchyProvider");
  return ctx;
}

/**
 * The brain and its voice, on the API origin — not on this origin.
 *
 * These used to be `/api/frenchy`, a path this app does not serve: there is no route handler
 * behind it and no rewrite in `next.config.mjs`, so every sentence would have 404'd against the
 * Next server and the failure would have read as a dead brain. The browser reaches the API
 * directly here exactly as it does in `lib/voice.ts` and `lib/useSnapshot.ts`, through the same
 * `API_BASE` constant — a second origin constant is a second answer to "which host replies".
 */
const FRENCHY_API = `${API_BASE}/frenchy`;
const FRENCHY_VOICE_API = `${API_BASE}/frenchy/voice`;

export function FrenchyProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FrenchyState>("idle");
  const [transcript, setTranscript] = useState("");
  const [messages, setMessages] = useState<FrenchyMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  const recognitionRef = useRef<any>(null);
  const scribeRef = useRef<ReturnType<typeof createScribeTranscriber> | null>(null);
  const audioRef = useRef<{ pause(): void } | null>(null);
  const isListeningRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const tracksRef = useRef<MediaTrack[]>([]);

  /**
   * Mirrors of the values the speech callbacks read.
   *
   * `SpeechRecognition`'s handlers are installed once, in an effect that never re-runs, so any
   * value they read out of the component body is frozen at the first render forever. That is
   * not a style note: `onend` compared a captured `state`, so it never matched and the host
   * could sit on "listening" after the recognizer had stopped; `onresult` read a captured
   * `messages`, so the history it sent was always the empty one. The refs keep a handler that
   * was installed once honest, without re-creating the recognizer in the middle of a sentence.
   */
  const stateRef = useRef<FrenchyState>(state);
  const messagesRef = useRef<FrenchyMessage[]>(messages);
  const mutedRef = useRef(isMuted);
  /** a permission dialog outlives a quick navigation; this says whether anyone is still here */
  const aliveRef = useRef(true);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    mutedRef.current = isMuted;
  }, [isMuted]);

  /**
   * The wallet, from the same account every other control reads.
   *
   * This used to be a local `useWallet()` that returned `null` under a comment saying a real
   * implementation would use wagmi. On a path that runs, a permanent `null` is not a
   * placeholder — it is a line fed to the brain: every answer would have said "your wallet: not
   * connected" while the header showed an address. `useAccount` is the truth, and it is legal
   * here because `Providers` mounts this component inside `WagmiProvider`.
   */
  const { address: walletAddress, chainId: walletChainId } = useAccount();
  const walletRef = useRef<{ address: string; chainId: number | null } | null>(null);
  useEffect(() => {
    walletRef.current = walletAddress
      ? { address: walletAddress, chainId: walletChainId ?? null }
      : null;
  }, [walletAddress, walletChainId]);

  /**
   * One controller per answer, and the previous one is cancelled before the next begins.
   *
   * `signal` without `abort()` is plumbing with nothing flowing through it: the fetch keeps
   * streaming into a callback that then speaks over the top of whatever was asked for next.
   * Every new utterance, every mute and the unmount all fire it.
   */
  const beginFetch = useCallback((): AbortController => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    return controller;
  }, []);

  /** Silence the answer in flight — the brain's, the clip's, and the browser voice's. */
  const stopSpeaking = useCallback(() => {
    cancelUtterance({
      tracks: tracksRef,
      synthesis: typeof window !== "undefined" ? window.speechSynthesis ?? null : null,
      controller: abortControllerRef.current,
      recognition: recognitionRef.current,
      audio: audioRef,
    });
  }, []);

  const playBlob = useCallback((blob: Blob): Promise<void> => {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (audioRef.current === audio) audioRef.current = null;
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        if (audioRef.current === audio) audioRef.current = null;
        reject(new Error("audio playback failed"));
      };
      audio.play().catch(reject);
    });
  }, []);

  const speakReply = useCallback(
    async (text: string, controller: AbortController) => {
      setState("speaking");

      // Premium voice first; the browser voice is the fallback, and a failed clip fetch is
      // silence rather than a second error the visitor has to interpret.
      try {
        const res = await fetch(FRENCHY_VOICE_API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        if (res.ok) {
          const blob = await res.blob();
          // A mute that landed while the bytes were streaming means the answer is already
          // unwanted. Do not hand it to an element that would start playing it.
          if (controller.signal.aborted || mutedRef.current) {
            setState("granted");
            return;
          }
          await playBlob(blob);
          setState("granted");
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
        // Fall through to the browser voice.
      }

      if (typeof window !== "undefined" && window.speechSynthesis) {
        if (controller.signal.aborted || mutedRef.current) return;

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "en-GB";
        utterance.rate = 0.95;
        utterance.pitch = 0.9;
        utterance.volume = 1;

        const voices = window.speechSynthesis.getVoices();
        const preferred =
          voices.find((v) => v.lang.startsWith("en-GB") || v.lang.startsWith("en-US")) ??
          voices.find((v) => v.lang.startsWith("en"));
        if (preferred) utterance.voice = preferred;

        utterance.onend = () => setState("granted");
        utterance.onerror = () => setState("granted");

        window.speechSynthesis.speak(utterance);
      } else {
        setState("granted");
      }
    },
    [playBlob],
  );

  const handleTranscript = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      setState("thinking");
      setTranscript("");

      const userMsg: FrenchyMessage = { role: "user", content: text, timestamp: Date.now() };
      // Read and written through the ref: this runs out of a handler installed once, and the
      // brain is graded on whether it remembers the sentence before this one.
      const history = messagesRef
        .current
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }));
      messagesRef.current = [...messagesRef.current, userMsg];
      setMessages((prev) => [...prev, userMsg]);

      const controller = beginFetch();

      try {
        const res = await fetch(FRENCHY_API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            // The server owns the context: it injects the read model itself, so the client
            // sends only what was said. `useSnapshot()` used to be called here too, which gave
            // every page a second live stream for data nothing in this file read.
            prompt: text,
            history,
            wallet: walletRef.current,
            mode: "text",
          }),
          signal: controller.signal,
        });

        if (!res.ok) throw new Error("brain error");
        const data = (await res.json()) as { reply?: unknown };
        const reply = typeof data.reply === "string" ? data.reply : "";
        if (!reply) throw new Error("brain error");

        const assistantMsg: FrenchyMessage = {
          role: "assistant",
          content: reply,
          timestamp: Date.now(),
        };
        messagesRef.current = [...messagesRef.current, assistantMsg];
        setMessages((prev) => [...prev, assistantMsg]);

        await speakReply(reply, controller);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // Cancelled on purpose — by a mute, or by the next sentence. Nothing to report.
          return;
        }
        setError("Frenchy is momentarily indisposed");
        setState("granted");
      }
    },
    [beginFetch, speakReply],
  );

  // ── speech recognition ────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") {
      setState("unavailable");
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setState("unavailable");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isListeningRef.current = true;
      setState("listening");
      // Barge-in: a visitor who starts talking has decided to interrupt the host.
      window.speechSynthesis?.cancel();
    };

    recognition.onresult = (event: any) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      setTranscript(final || interim);
      if (final) {
        setState("transcribing");
        void handleTranscript(final.trim());
      }
    };

    recognition.onerror = (event: any) => {
      isListeningRef.current = false;
      if (event.error === "no-speech" || event.error === "audio-capture") {
        // A silent timeout is not a failure; the microphone simply heard nothing.
        setState("granted");
      } else if (event.error === "not-allowed") {
        setState("denied");
        setError("Microphone access denied. Enable it in your browser settings.");
      } else {
        setError(`Speech recognition error: ${event.error}`);
        setState("granted");
      }
      setTranscript("");
    };

    recognition.onend = () => {
      isListeningRef.current = false;
      // The live mirror, not the captured `state` — which is why this transition used to never
      // fire, and the host could sit on "listening" after the recognizer had already stopped.
      const current = stateRef.current;
      if (current === "listening" || current === "transcribing") setState("granted");
    };

    recognitionRef.current = recognition;

    void checkPermission();
    // No cleanup here: recognition is stopped by the single teardown below. A second path that
    // stopped it would only either race that one or run before the fetch it is meant to cut.
  }, [handleTranscript]);

  async function checkPermission() {
    try {
      const perm = await navigator.permissions.query({ name: "microphone" as PermissionName });
      if (perm.state === "granted") setState("granted");
      else if (perm.state === "denied") {
        setState("denied");
        setError("Microphone access denied. Enable it in your browser settings.");
      } else setState("prompt");
    } catch {
      setState("prompt");
    }
  }

  /**
   * Ask for the microphone, then hand it straight back.
   *
   * `SpeechRecognition` opens its own capture, and holding a second live stream would keep the
   * tab's recording light on for as long as the page did. So this is a permission probe, not a
   * tap on the line — but the tracks are recorded in `tracksRef` before anything else happens,
   * because the permission dialog is the one step here that waits for a human: if the visitor
   * navigates away while it is open, the stream that arrives after this component is gone is
   * stopped on arrival rather than left running with nobody to speak for.
   */
  async function enable() {
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setState("unavailable");
      return;
    }

    // Prefer ElevenLabs Scribe Realtime when a signed URL is available — it streams
    // partial + committed transcripts with lower latency than the browser recognizer.
    // Fall back to the native recognizer otherwise.
    try {
      const scribe = createScribeTranscriber(API_BASE, {
        onPartial: (t) => setTranscript(t),
        onCommitted: (t) => {
          setTranscript("");
          void handleTranscript(t.trim());
        },
        onError: (err) => {
          setError(`Transcription error: ${err.message}`);
          setState("granted");
        },
      });
      const started = await scribe.start();
      if (started) {
        scribeRef.current = scribe;
        setState("granted");
        setError(null);
        return;
      }
    } catch {
      // Fall through to the browser recognizer.
    }

    try {
      setState("prompt");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tracks = stream.getTracks();
      if (!aliveRef.current) {
        for (const track of tracks) track.stop();
        return;
      }
      tracksRef.current = tracks;
      for (const track of tracks) track.stop();
      tracksRef.current = [];
      setState("granted");
      setError(null);
      startListening();
    } catch {
      setState("denied");
      setError(
        "Microphone access denied. Enable it in your browser settings: chrome://settings/content/microphone",
      );
    }
  }

  function startListening() {
    if (mutedRef.current) return;
    if (stateRef.current === "speaking") return;
    if (recognitionRef.current && !isListeningRef.current) {
      try {
        recognitionRef.current.start();
      } catch {
        // Already started or not ready; `onerror` is the channel that matters.
      }
    }
  }

  function stopListening() {
    if (scribeRef.current) {
      scribeRef.current.stop();
      scribeRef.current = null;
    }
    if (recognitionRef.current && isListeningRef.current) {
      recognitionRef.current.stop();
    }
  }

  async function sendText(text: string) {
    if (!text.trim()) return;
    setError(null);
    await handleTranscript(text.trim());
  }

  function dismissError() {
    setError(null);
  }

  /**
   * Stop this answer, keep the preference.
   *
   * Mute says "be quiet from now on"; closing the panel says "I am done with this one". They
   * cannot be the same call: a visitor who shut a panel and came back to find the host muted is
   * a visitor who now gets silence he did not ask for. The state is only pushed back to
   * "granted" when it was one of the in-flight states, so a page that never had the microphone
   * is not reported as having it.
   */
  function cancel() {
    stopSpeaking();
    stopListening();
    setState((current) =>
      current === "thinking" || current === "speaking" || current === "transcribing" || current === "listening"
        ? "granted"
        : current,
    );
  }

  /**
   * Mute is an interruption, not a preference written to a list.
   *
   * Before, this set a flag and cancelled the browser voice while the brain fetch kept running
   * — so the answer arrived a second later, found the flag set, and spoke anyway. The
   * controller is fired now: that is the only thing that stops a sentence still being composed.
   */
  function mute() {
    setIsMuted(true);
    mutedRef.current = true;
    stopSpeaking();
    stopListening();
    setState("granted");
  }

  function unmute() {
    setIsMuted(false);
    mutedRef.current = false;
  }

  // A page may ask the host to speak — a paid verdict, and nothing else does.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: CustomEvent<string>) => {
      if (!mutedRef.current && stateRef.current === "granted") {
        void speakReply(event.detail, beginFetch());
      }
    };
    window.addEventListener("frenchy-speak", handler as EventListener);
    return () => window.removeEventListener("frenchy-speak", handler as EventListener);
  }, [beginFetch, speakReply]);

  /**
   * One release path on unmount, and it is the only one.
   *
   * Chrome survives route changes, so this runs once per page load rather than once per
   * sentence — which is also why it has to be complete: a track left alive here keeps the
   * microphone lit until the tab closes. The order and the end state live in `teardown.ts`,
   * where they are testable without a renderer.
   */
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      teardownFrenchy({
        tracks: tracksRef,
        synthesis: typeof window !== "undefined" ? window.speechSynthesis ?? null : null,
        controller: abortControllerRef.current,
        recognition: recognitionRef.current,
        audio: audioRef,
      });
      abortControllerRef.current = null;
      recognitionRef.current = null;
      scribeRef.current?.stop();
      scribeRef.current = null;
    };
  }, []);

  const value: FrenchyContextValue = {
    state,
    transcript,
    messages,
    error,
    enable,
    startListening,
    stopListening,
    sendText,
    dismissError,
    cancel,
    mute,
    unmute,
    isMuted,
  };

  return <FrenchyContext.Provider value={value}>{children}</FrenchyContext.Provider>;
}
