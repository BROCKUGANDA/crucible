/**
 * The envelope Frenchy answers in, and what the host does with it.
 *
 * The model is asked for one JSON object. Nothing here trusts it: the spoken
 * line is length-capped because the voice route refuses more, the detail is
 * length-capped because a panel that grows without bound is a page that can
 * be made to stop responding, and **an action is only ever carried out if the
 * path is a page of this site and the point is an id that page declares**.
 *
 * That last rule is the whole of "computer use" in one check. A model that
 * answers `{"kind":"navigate","path":"/pay-someone"}` gets a refusal, not a
 * navigation: the destination has to exist, and the only place that decides
 * what exists is the site index, which is generated from the pages themselves.
 */

import { readAction as readSiteAction, type SiteAction } from "@crucible/site-index";

/** What Frenchy may do. Two verbs, and no money in either of them. */
export type FrenchyAction = SiteAction;

/** One answer: what to say, what to show, and what to do. */
export interface FrenchyAnswer {
  /** What the visitor hears. */
  spoken: string;
  /** What the visitor reads. Null when there is nothing more to say. */
  detail: string | null;
  /** What the browser does. Null when nothing needs doing. */
  action: FrenchyAction | null;
}

/** The spoken line is bounded by the voice route, which refuses more. */
export const MAX_SPOKEN_CHARS = 600;
/** The panel is bounded so a page cannot be made to stop responding. */
export const MAX_DETAIL_CHARS = 4_000;

/**
 * The spoken window of a piece of text.
 *
 * The voice route refuses more than 600 characters, so a longer answer has to
 * be cut somewhere. Cutting at a sentence boundary rather than mid-word is
 * the difference between an answer that sounds finished and one that sounds
 * broken; when there is no boundary to cut at, the cut is at a word and the
 * ellipsis says so rather than pretending the sentence ended there.
 */
export function spokenWindow(text: string, max = MAX_SPOKEN_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;

  const window = trimmed.slice(0, max);
  const boundary = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  if (boundary > max / 2) return window.slice(0, boundary + 1).trim();

  const space = window.lastIndexOf(" ");
  return `${(space > 0 ? window.slice(0, space) : window).trimEnd()}…`;
}

export interface ParsedEnvelope {
  /** The answer, or null when the model did not answer in the envelope. */
  answer: FrenchyAnswer | null;
  /**
   * What was refused, and why.
   *
   * A refusal is worth recording: a model that keeps asking for a page that
   * does not exist is a model whose prompt is out of date, and that is a fact
   * an operator needs to see rather than a silent no-op.
   */
  refused: string[];
}

/** Strip a markdown fence, if the model wrapped its JSON in one. */
function unfence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\s*/, "");
  return withoutOpen.replace(/```\s*$/, "").trim();
}

/**
 * Read the envelope out of what the model said.
 *
 * Returns null for the answer when the model did not answer in the envelope
 * at all - in which case the caller speaks the raw text, exactly as it did
 * before this existed. The old behaviour is the fallback, not a second
 * path: a model that ignores the format still says something useful.
 */
export function parseEnvelope(raw: string): ParsedEnvelope {
  const refused: string[] = [];
  const text = unfence(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { answer: null, refused };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { answer: null, refused };
  }

  const envelope = parsed as Record<string, unknown>;

  const spokenRaw = envelope.spoken;
  if (typeof spokenRaw !== "string" || !spokenRaw.trim()) {
    return { answer: null, refused };
  }
  const spoken = spokenRaw.trim().slice(0, MAX_SPOKEN_CHARS);

  const detailRaw = envelope.detail;
  const detail =
    typeof detailRaw === "string" && detailRaw.trim()
      ? // A model that writes `\\n` inside its JSON meant a newline and got
        // two characters. The detail is a text body, so the escape is
        // resolved once here rather than showing the visitor a line that
        // reads "- Locked: what trials still hold\n- Free stake: ...".
        detailRaw.trim().replace(/\\n/g, "\n").slice(0, MAX_DETAIL_CHARS)
      : null;

  const action = readHostAction(envelope.action, refused);

  return { answer: { spoken, detail, action }, refused };
}

/**
 * Read the action, and refuse the ones that are not allowed.
 *
 * The rule itself lives in `@crucible/site-index`, because the browser has to
 * refuse exactly what the host refuses: two copies of one rule are two
 * chances to disagree, and a disagreement between them is a hole rather than
 * a gate. This function keeps the host's half - recording the refusal - and
 * borrows the decision.
 */
function readHostAction(value: unknown, refused: string[]): FrenchyAction | null {
  const { action, refused: reasons } = readSiteAction(value);
  refused.push(...reasons);
  return action;
}
