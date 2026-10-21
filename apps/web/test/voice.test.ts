import { describe, expect, it } from "vitest";
import {
  localDay,
  markCatchphrase,
  markSpoken,
  readVoicePrefs,
  shouldSpeak,
  verdictMoment,
  writeVoiceEnabled,
  VOICE_CATCHPHRASE_KEY,
  VOICE_DAY_KEY,
  VOICE_ENABLED_KEY,
} from "../src/lib/voice.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (i) => [...values.keys()][i] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  } as Storage;
}

describe("Frenchy's policy", () => {
  it("is off until the user turns it on", () => {
    const storage = memoryStorage();
    expect(readVoicePrefs(storage)).toEqual({
      enabled: false,
      lastDay: null,
      catchphraseUsed: false,
    });
    expect(
      shouldSpeak({
        enabled: false,
        reducedMotion: false,
        lastDay: null,
        today: "2026-10-21",
      }),
    ).toBe(false);
  });

  it("speaks once a day, and not when reduced motion is requested", () => {
    const base = { enabled: true, reducedMotion: false, today: "2026-10-21" };
    expect(shouldSpeak({ ...base, lastDay: null })).toBe(true);
    expect(shouldSpeak({ ...base, lastDay: "2026-10-20" })).toBe(true);
    expect(shouldSpeak({ ...base, lastDay: "2026-10-21" })).toBe(false);
    expect(shouldSpeak({ ...base, reducedMotion: true, lastDay: null })).toBe(false);
  });

  it("lets a manual click through even after the daily line", () => {
    expect(
      shouldSpeak({
        enabled: true,
        reducedMotion: true,
        lastDay: "2026-10-21",
        today: "2026-10-21",
        manual: true,
      }),
    ).toBe(true);
    // …but never when the host is off.
    expect(
      shouldSpeak({
        enabled: false,
        reducedMotion: false,
        lastDay: null,
        today: "2026-10-21",
        manual: true,
      }),
    ).toBe(false);
  });

  it("uses the catchphrase once per session", () => {
    expect(verdictMoment(false)).toBe("verdict");
    expect(verdictMoment(true)).toBe("verdict-repeat");
  });

  it("reads and writes the persisted prefs", () => {
    const storage = memoryStorage();
    writeVoiceEnabled(storage, true);
    expect(storage.getItem(VOICE_ENABLED_KEY)).toBe("1");
    markSpoken(storage, "2026-10-21");
    expect(storage.getItem(VOICE_DAY_KEY)).toBe("2026-10-21");
    markCatchphrase(storage);
    expect(storage.getItem(VOICE_CATCHPHRASE_KEY)).toBe("1");
    expect(readVoicePrefs(storage)).toEqual({
      enabled: true,
      lastDay: "2026-10-21",
      catchphraseUsed: true,
    });
    writeVoiceEnabled(storage, false);
    expect(readVoicePrefs(storage).enabled).toBe(false);
  });

  it("formats the user's local day, not UTC", () => {
    expect(localDay(new Date(2026, 9, 21, 23, 59))).toBe("2026-10-21");
    expect(localDay(new Date(2026, 0, 2, 0, 1))).toBe("2026-01-02");
  });
});
