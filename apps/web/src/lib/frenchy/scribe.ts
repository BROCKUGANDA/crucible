"use client";

/**
 * ElevenLabs Scribe Realtime — streaming transcription for Frenchy.
 *
 * Scribe Realtime is used as a *custom transcription pipeline* (partial + committed
 * transcripts with low latency), distinct from the ElevenLabs Agents conversational
 * loop which owns the full turn. The browser captures microphone audio, streams it
 * over a WebSocket, and receives partial/committed transcripts. A committed
 * transcript is handed to Frenchy's brain exactly as a browser `SpeechRecognition`
 * final result would be.
 *
 * Auth: browsers cannot set the `xi-api-key` header on a WebSocket. The connection
 * therefore uses a signed URL. Two sources are supported, in order:
 *
 *   1. `NEXT_PUBLIC_ELEVENLABS_SCRIBE_URL` — a fully-formed signed `wss://` URL
 *      baked into the bundle (operator-provided).
 *   2. `${API_BASE}/frenchy/scribe-url` — the API mints a short-lived signed URL
 *      and returns `{ url }`. The API holds the ElevenLabs key; the browser never
 *      sees it.
 *
 * If neither is available, callers fall back to the built-in `SpeechRecognition`.
 */

export interface ScribeCallbacks {
  onPartial?: (text: string) => void;
  onCommitted?: (text: string) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

export interface ScribeSession {
  sendAudio(chunk: ArrayBuffer | Blob): void;
  close(): void;
  readonly ready: boolean;
}

export async function resolveScribeUrl(apiBase: string): Promise<string | null> {
  const direct = (process.env.NEXT_PUBLIC_ELEVENLABS_SCRIBE_URL ?? "").trim();
  if (direct && /^wss?:\/\//.test(direct)) return direct;

  try {
    const res = await fetch(`${apiBase}/frenchy/scribe-url`, { method: "GET" });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { url?: string } | null;
    if (body && typeof body.url === "string" && /^wss?:\/\//.test(body.url)) return body.url;
  } catch {
    // Network or parse failure — fall back to browser recognition.
  }
  return null;
}

export function openScribeSession(url: string, callbacks: ScribeCallbacks): ScribeSession {
  let ws: WebSocket | null = null;
  let ready = false;
  const queue: (ArrayBuffer | Blob)[] = [];

  try {
    ws = new WebSocket(url);
  } catch (err) {
    callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    return { sendAudio() {}, close() {}, ready: false };
  }

  ws.onopen = () => {
    ready = true;
    // Flush any audio captured before the socket opened.
    for (const chunk of queue.splice(0)) send(chunk);
  };

  ws.onmessage = (event) => {
    let payload: any;
    try {
      payload = typeof event.data === "string" ? JSON.parse(event.data) : null;
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;

    // Scribe Realtime emits committed/partial transcript messages.
    const text =
      typeof payload.text === "string"
        ? payload.text
        : typeof payload.transcript === "string"
          ? payload.transcript
          : "";

    if (payload.type === "partial_transcript" || payload.is_partial) {
      if (text) callbacks.onPartial?.(text);
    } else if (payload.type === "committed_transcript" || payload.is_final) {
      if (text) callbacks.onCommitted?.(text);
    } else if (payload.type === "error" || payload.error) {
      callbacks.onError?.(new Error(payload.error ?? payload.message ?? "scribe error"));
    }
  };

  ws.onerror = () => {
    callbacks.onError?.(new Error("scribe websocket error"));
  };

  ws.onclose = () => {
    ready = false;
    callbacks.onClose?.();
  };

  function send(chunk: ArrayBuffer | Blob) {
    if (!ws) return;
    if (ws.readyState !== WebSocket.OPEN) {
      queue.push(chunk);
      return;
    }
    try {
      if (chunk instanceof Blob) {
        chunk.arrayBuffer().then((buf) => ws && ws.readyState === WebSocket.OPEN && ws.send(buf));
      } else {
        ws.send(chunk);
      }
    } catch (err) {
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return {
    sendAudio: send,
    close() {
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
      ready = false;
    },
    get ready() {
      return ready && ws?.readyState === WebSocket.OPEN;
    },
  };
}
