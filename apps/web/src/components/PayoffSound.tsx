"use client";

import { useCallback, useEffect, useState } from "react";
import { celebrate, disposeSound, isSoundEnabled, setSoundEnabled, soundSupported } from "@/lib/sound-pref";

/**
 * The site's own sound, on a switch the visitor flips.
 *
 * What plays is the synthesized motif in `lib/money-sound.ts` — ours, no clip of anyone's record.
 * The track a visitor may actually be after is one link away: the CUE IT chip on a paid trial
 * opens it in their own streaming app (gate 434's rule, which this component does not touch).
 *
 * Off by default, and it only ever plays after a click: browsers block unsolicited audio, and
 * the voice control beside it already runs on "off until asked" (`lib/voice.ts`).
 */
export function PayoffSound(): React.ReactElement | null {
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setSupported(soundSupported());
    setEnabled(isSoundEnabled());
  }, []);

  // The context belongs to this control's lifetime, so leaving the page releases it.
  useEffect(() => () => disposeSound(), []);

  const toggle = useCallback(() => {
    const next = !isSoundEnabled();
    setSoundEnabled(next);
    setEnabled(next);
    // Turning it on is the one moment that must be audible: a switch that silences itself until
    // the next event reads as broken rather as polite.
    if (next) celebrate();
  }, []);

  if (!supported) return null;

  return (
    <button
      type="button"
      className={`sound-toggle${enabled ? " sound-toggle--on" : ""}`}
      onClick={toggle}
      aria-pressed={enabled}
      title={enabled ? "Mute the site's money sound" : "Play the site's money sound when something lands"}
    >
      <span className="sound-toggle__mark" aria-hidden="true">
        {enabled ? "♪" : "·"}
      </span>
      <span className="sound-toggle__label">{enabled ? "sound on" : "sound off"}</span>
    </button>
  );
}
