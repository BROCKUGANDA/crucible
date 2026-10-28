"use client";

import { resolveScribeUrl, openScribeSession, type ScribeSession } from "./scribe";

/**
 * Manages a microphone -> Scribe Realtime transcription pipeline.
 *
 * Returns a controller with `start()` and `stop()`. Partial transcripts are
 * delivered through `onPartial`; committed transcripts through `onCommitted`.
 * Falls back gracefully: if no signed URL can be resolved, `start()` resolves
 * to `false` and the caller should use the browser recognizer instead.
 */
export interface ScribeTranscriber {
  start(): Promise<boolean>;
  stop(): void;
  readonly active: boolean;
}

export function createScribeTranscriber(
  apiBase: string,
  callbacks: { onPartial: (t: string) => void; onCommitted: (t: string) => void; onError?: (e: Error) => void; onClose?: () => void },
): ScribeTranscriber {
  let session: ScribeSession | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let active = false;

  async function start(): Promise<boolean> {
    const url = await resolveScribeUrl(apiBase);
    if (!url) return false;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      return false;
    }

    session = openScribeSession(url, {
      onPartial: callbacks.onPartial,
      onCommitted: callbacks.onCommitted,
      onError: callbacks.onError,
      onClose: callbacks.onClose,
    });

    // Prefer a mime type the browser supports; MediaRecorder defaults otherwise.
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";

    try {
      mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (err) {
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      session.close();
      session = null;
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      return false;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0 && session) session.sendAudio(e.data);
    };
    mediaRecorder.start(250); // 250ms chunks for low latency
    active = true;
    return true;
  }

  function stop() {
    active = false;
    try {
      mediaRecorder?.stop();
    } catch {
      /* ignore */
    }
    mediaRecorder = null;
    session?.close();
    session = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  return {
    start,
    stop,
    get active() {
      return active;
    },
  };
}
