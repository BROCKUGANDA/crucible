/**
 * The two release paths Frenchy needs, as plain functions over plain objects.
 *
 * They live apart from the provider for one reason: this repo has no React renderer in its
 * test suite, so anything that only a component could do would be untestable, and an
 * untested release path is a path that leaks a microphone. Shaped as data, the ordering and
 * the end state are both assertable. The React side does nothing but hand over its refs —
 * and a ref is `{ current }`, which is exactly the shape taken here.
 *
 * Order is not stylistic. Every step is a resource the *browser* can still see: a live media
 * track keeps the tab's microphone lit and keeps a permission the visitor granted for one
 * sentence, and an unfinished fetch keeps a socket plus a pending resolution that will call
 * `setState` on a component that no longer exists. So the capture device is released first,
 * before anything that could hand it more work, and the audio element — the thing a person
 * hears — is silenced last so a teardown never leaves a half-spoken sentence behind.
 *
 * Every step is guarded on its own. `SpeechRecognition.stop()` throws when the recognizer was
 * never started, and an uncaught throw in the middle of this sequence would abandon whatever
 * came after it: the microphone would stay on. A step that fails is recorded and the sequence
 * continues.
 */

export type TeardownStep = "tracks" | "synthesis" | "fetch" | "recognition" | "audio";

export interface MediaTrack {
  stop(): void;
}

export interface SpeechSynthesizer {
  cancel(): void;
}

export interface Abortable {
  abort(): void;
  signal?: { aborted?: boolean };
}

export interface Recognizer {
  stop(): void;
}

export interface Playable {
  pause(): void;
}

/** The pieces the provider holds, passed by ref so clearing them is observable. */
export interface FrenchyResources {
  tracks: { current: MediaTrack[] } | null;
  synthesis: SpeechSynthesizer | null;
  controller: Abortable | null;
  recognition: Recognizer | null;
  audio: { current: Playable | null } | null;
}

export interface TeardownReport {
  /** the steps that actually ran, in the order they ran */
  steps: TeardownStep[];
  /** a step that threw is named here rather than swallowed */
  failures: { step: TeardownStep; message: string }[];
}

/**
 * Stop everything Frenchy is holding. Called exactly once, from the provider's unmount.
 *
 * The report is the contract the test reads: `steps` must name each resource that existed, in
 * order, and the caller's own refs must be empty afterwards. Absent resources are absent from
 * `steps` — a report that claimed to have stopped a microphone that was never opened would be
 * the same kind of lie as a green test that waited for nothing.
 */
export function teardownFrenchy(resources: FrenchyResources): TeardownReport {
  const steps: TeardownStep[] = [];
  const failures: TeardownReport["failures"] = [];

  const run = (step: TeardownStep, action: () => void): void => {
    try {
      action();
      steps.push(step);
    } catch (err) {
      failures.push({ step, message: err instanceof Error ? err.message : String(err) });
      steps.push(step);
    }
  };

  const tracks = resources.tracks?.current ?? [];
  if (resources.tracks && tracks.length > 0) {
    run("tracks", () => {
      for (const track of [...tracks]) track.stop();
      resources.tracks!.current = [];
    });
  }

  if (resources.synthesis) {
    run("synthesis", () => resources.synthesis!.cancel());
  }

  if (resources.controller) {
    run("fetch", () => resources.controller!.abort());
  }

  if (resources.recognition) {
    run("recognition", () => resources.recognition!.stop());
  }

  if (resources.audio?.current) {
    run("audio", () => {
      resources.audio!.current?.pause();
      resources.audio!.current = null;
    });
  }

  return { steps, failures };
}

/**
 * Silence the current answer without giving up the session.
 *
 * This is what `mute()` and a new utterance run: the fetch in flight is cancelled (not
 * abandoned — an abandoned fetch keeps streaming into a callback that will speak again), the
 * browser voice is stopped, and the clip element is released so its `onended` cannot fire
 * later and set the state back to speaking.
 *
 * It takes the same bag as `teardownFrenchy` and deliberately releases less of it. The
 * microphone is *not* stopped and the recognizer is *not* shut: muting a host should not revoke
 * the permission a visitor granted, and the recognizer keeps its own capture alive for the next
 * click. Passing the whole bag rather than the three fields is what makes that difference
 * testable — a function that cannot see the tracks cannot be shown to have stopped them, and an
 * assertion nobody can turn red is the failure mode this repo already has a gate against.
 */
export function cancelUtterance(resources: FrenchyResources): TeardownStep[] {
  const done: TeardownStep[] = [];

  if (resources.controller) {
    resources.controller.abort();
    done.push("fetch");
  }
  if (resources.synthesis) {
    resources.synthesis.cancel();
    done.push("synthesis");
  }
  if (resources.audio?.current) {
    resources.audio.current.pause();
    resources.audio.current = null;
    done.push("audio");
  }

  return done;
}
