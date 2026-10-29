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
import { useRouter } from "next/navigation";
import { readAction, type SiteAction } from "@crucible/site-index";
import { decideAction } from "./action";
import { API_BASE } from "@/lib/apiBase";
import { interactionPending } from "@/lib/interaction";
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
  /**
   * What the visitor reads, when the spoken line was not the whole answer.
   *
   * The mouth and the screen are separate: the spoken line is three sentences
   * the voice can carry, and the detail is the depth - the numbers, the lists,
   * one line per item - which a spoken paragraph would have lost.
   */
  detail?: string | null;
  /**
   * What she did, and what she was refused.
   *
   * `action` is the action that was carried out. `offered` is the one she
   * wanted but could not carry out - because a wallet signature was open, or
   * because the browser could not find what she pointed at - and it is kept
   * because a visitor who was not moved deserves to be told what was on the
   * table.
   */
  action?: SiteAction | null;
  offered?: SiteAction | null;
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
  /** Speak a piece of text - the panel's "read it to me". */
  speak: (text: string) => Promise<void>;
  dismissError: () => void;
  /** stop this answer without changing the visitor's mute preference */
  cancel: () => void;
  mute: () => void;
  unmute: () => void;
  isMuted: boolean;
  /**
   * Whether the Frenchy panel is open.
   *
   * It lives here rather than in the panel's own component because the header
   * is **per page** while this provider is **per layout** - so a panel whose
   * state was its own would be unmounted by the very navigation Frenchy
   * makes, and the answer she had just given would disappear on the page she
   * sent the visitor to. Keeping the flag here means the answer survives the
   * journey, and the panel opens again on arrival.
   */
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
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
  const [panelOpen, setPanelOpen] = useState(false);
  const router = useRouter();

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

  /**
   * Carry out what Frenchy asked for.
   *
   * Two verbs, and the rule that governs both is that **the visitor is not
   * moved while a signature is open**: the wallet's dialog belongs to the page
   * that opened it, and navigating underneath it leaves a confirmed
   * transaction with no receipt on screen. So while anything is being signed,
   * she speaks and offers instead of taking - and the offer is kept on the
   * message, because a visitor who was not moved deserves to know what was on
   * the table.
   *
   * A point that lands nowhere is refused too: the id was promised by the
   * page's own descriptor, so an element that is not there means the page and
   * the map have drifted, and drifting is worth saying rather than hiding.
   */
  const applyAction = useCallback(
    (action: SiteAction): { action: SiteAction | null; offered: SiteAction | null } => {
      const point = action.kind === "point" && action.point ? document.getElementById(action.point) : null;
      const decision = decideAction(action, {
        signatureOpen: interactionPending(),
        pointExists: point !== null,
      });

      if (!decision.action) return { action: null, offered: decision.offered };

      if (decision.action.kind === "navigate") {
        router.push(decision.action.path);
        return { action: decision.action, offered: null };
      }

      if (!point) return { action: null, offered: decision.offered };
      point.scrollIntoView({ behavior: "smooth", block: "center" });
      point.classList.add("frenchy-pointed");
      window.setTimeout(() => point.classList.remove("frenchy-pointed"), 2400);
      return { action: decision.action, offered: null };
    },
    [router],
  );

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
        const data = (await res.json()) as { reply?: unknown; detail?: unknown; action?: unknown };
        const reply = typeof data.reply === "string" ? data.reply : "";
        if (!reply) throw new Error("brain error");

        const detail = typeof data.detail === "string" && data.detail.trim() ? data.detail : null;

        // The host has already checked the action against the site index; the
        // browser checks it again, because the two have to agree and only the
        // browser knows what it can actually do. The rule itself is one rule,
        // in the package both of them import.
        const { action: wanted } = readAction(data.action);
        const applied = wanted ? applyAction(wanted) : { action: null, offered: null };

        // The panel opens again on the page she sent the visitor to, so the
        // answer is there to read when they arrive. The header is per page
        // and this provider is per layout, which is why the flag lives here.
        if (applied.action || applied.offered) setPanelOpen(true);

        const assistantMsg: FrenchyMessage = {
          role: "assistant",
          content: reply,
          timestamp: Date.now(),
          detail,
          action: applied.action,
          offered: applied.offered,
        };
        messagesRef.current = [...messagesRef.current, assistantMsg];
        setMessages((prev) => [...prev, assistantMsg]);

        // The redirect and the speech start together: the visitor is moved
        // while she is still talking, which is what "shall I take you there"
        // means.
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
    [beginFetch, speakReply, applyAction],
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
        onClose: () => {
          if (scribeRef.current) {
            scribeRef.current = null;
            setState((c) => (c === "listening" || c === "transcribing" ? "granted" : c));
          }
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

  /**
   * Speak a piece of text that is already on the screen.
   *
   * The panel's "read it to me": the detail was written for the eye, and a
   * visitor who wants it spoken should not have to ask the question again.
   */
  const speak = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      await speakReply(trimmed, beginFetch());
    },
    [beginFetch, speakReply],
  );

  const value: FrenchyContextValue = {
    state,
    transcript,
    messages,
    error,
    enable,
    startListening,
    stopListening,
    sendText,
    speak,
    dismissError,
    cancel,
    mute,
    unmute,
    isMuted,
    panelOpen,
    setPanelOpen,
  };

  return <FrenchyContext.Provider value={value}>{children}</FrenchyContext.Provider>;
}
