"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useSnapshot } from "@/lib/useSnapshot";

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

const FRENCHY_API = "/api/frenchy";
const FRENCHY_VOICE_API = "/api/frenchy/voice";

export function FrenchyProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FrenchyState>("idle");
  const [transcript, setTranscript] = useState("");
  const [messages, setMessages] = useState<FrenchyMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isListeningRef = useRef(false);
  const walletRef = useRef<{ address: string } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Snapshot subscription for live CRUCIBLE context
  useSnapshot();
  const wallet = useWallet();

  // Update wallet ref when it changes
  useEffect(() => {
    walletRef.current = wallet;
  }, [wallet]);

  // Initialize speech recognition
  useEffect(() => {
    if (typeof window === "undefined") {
      setState("unavailable");
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
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
      // Barge-in: cancel any ongoing speech synthesis
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };

    recognition.onresult = (event: any) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          final += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
      setTranscript(final || interim);
      if (final) {
        setState("transcribing");
        handleTranscript(final.trim());
      }
    };

    recognition.onerror = (event: any) => {
      isListeningRef.current = false;
      if (event.error === "no-speech" || event.error === "audio-capture") {
        // Silent timeout - just return to idle
        setState("granted");
        setTranscript("");
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
      if (state === "listening" || state === "transcribing") {
        setState("granted");
      }
    };

    recognitionRef.current = recognition;

    // Check initial permission
    checkPermission();

    return () => {
      recognition.stop();
    };
  }, []);

  async function checkPermission() {
    try {
      const perm = await navigator.permissions.query({ name: "microphone" as PermissionName });
      if (perm.state === "granted") {
        setState("granted");
      } else if (perm.state === "denied") {
        setState("denied");
        setError("Microphone access denied. Enable it in your browser settings.");
      } else {
        setState("prompt");
      }
    } catch {
      setState("prompt");
    }
  }

  async function enable() {
    if (typeof window === "undefined") return;

    try {
      setState("prompt");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setState("granted");
      setError(null);
      startListening();
    } catch (err) {
      setState("denied");
      setError("Microphone access denied. Enable it in your browser settings: chrome://settings/content/microphone");
    }
  }

  function startListening() {
    if (isMuted) return;
    if (state === "speaking") return; // Don't interrupt speech
    if (recognitionRef.current && !isListeningRef.current) {
      try {
        recognitionRef.current.start();
      } catch {
        // Already started or not ready
      }
    }
  }

  function stopListening() {
    if (recognitionRef.current && isListeningRef.current) {
      recognitionRef.current.stop();
    }
  }

  async function handleTranscript(text: string) {
    if (!text.trim()) return;

    setState("thinking");
    setTranscript("");

    // Add user message
    const userMsg: FrenchyMessage = { role: "user", content: text, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const prompt = buildPrompt(text);
      abortControllerRef.current = new AbortController();

      const res = await fetch(FRENCHY_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt,
          history: messages.slice(-12).map((m) => ({ role: m.role, content: m.content })),
          wallet: walletRef.current,
          mode: "text",
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!res.ok) throw new Error("brain error");
      const data = await res.json();

      const assistantMsg: FrenchyMessage = { role: "assistant", content: data.reply, timestamp: Date.now() };
      setMessages((prev) => [...prev, assistantMsg]);

      // Speak the reply using browser TTS (MVP) or premium TTS
      await speakReply(data.reply);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError("Frenchy is momentarily indisposed");
      setState("granted");
    }
  }

  function buildPrompt(userText: string): string {
    // The server builds full context from the snapshot; we just send the user text
    // The server injects CRUCIBLE state from the read model
    return userText;
  }

  async function speakReply(text: string) {
    setState("speaking");

    // Try premium TTS first if available
    try {
      const res = await fetch(FRENCHY_VOICE_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const blob = await res.blob();
        await playBlob(blob);
        setState("granted");
        return;
      }
    } catch {
      // Fall through to browser TTS
    }

    // Fallback: browser speechSynthesis
    if (typeof window !== "undefined" && window.speechSynthesis) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-GB";
      utterance.rate = 0.95;
      utterance.pitch = 0.9;
      utterance.volume = 1;

      // Pick a butler-like voice
      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(
        (v) => v.lang.startsWith("en-GB") || v.lang.startsWith("en-US")
      ) ?? voices.find((v) => v.lang.startsWith("en"));
      if (preferred) utterance.voice = preferred;

      utterance.onend = () => {
        if (audioRef.current) {
          audioRef.current = null;
        }
        setState("granted");
      };
      utterance.onerror = () => {
        setState("granted");
      };

      window.speechSynthesis.speak(utterance);
    } else {
      setState("granted");
    }
  }

  function playBlob(blob: Blob): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        audioRef.current = null;
        reject(new Error("audio playback failed"));
      };
      audio.play().catch(reject);
    });
  }

  async function sendText(text: string) {
    if (!text.trim()) return;
    setError(null);
    await handleTranscript(text.trim());
  }

  function dismissError() {
    setError(null);
  }

  function mute() {
    setIsMuted(true);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    stopListening();
    setState("granted");
  }

  function unmute() {
    setIsMuted(false);
  }

  // Expose a way for other components to trigger speech (e.g., verdict events)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: CustomEvent<string>) => {
      if (!isMuted && state === "granted") {
        speakReply(event.detail);
      }
    };
    window.addEventListener("frenchy-speak", handler as EventListener);
    return () => window.removeEventListener("frenchy-speak", handler as EventListener);
  }, [isMuted, state]);

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
    mute,
    unmute,
    isMuted,
  };

  return <FrenchyContext.Provider value={value}>{children}</FrenchyContext.Provider>;
}

// Hook to get wallet from providers (simplified - assumes wagmi)
function useWallet(): { address: string } | null {
  // This would integrate with wagmi/useAccount in real implementation
  // For now return null - the provider reads from context
  return null;
}