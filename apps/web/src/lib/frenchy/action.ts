/**
 * What to do with the action Frenchy asked for.
 *
 * The decision is a pure function of the action and of two facts about the
 * world, so it can be tested without a browser: what she asked for, whether
 * a wallet signature is open, and whether the thing she pointed at is
 * actually on the page.
 *
 * The rule that matters is the first one. **A signature outranks a
 * redirect**: the wallet's dialog belongs to the page that opened it, and
 * navigating underneath it leaves a confirmed transaction with no receipt on
 * screen. So while anything is being signed she speaks and *offers*, and the
 * offer is kept on the message - a visitor who was not moved deserves to know
 * there was somewhere to go.
 */

import type { SiteAction } from "@crucible/site-index";

export interface ActionDecision {
  /** The action to carry out, or null when there is nothing to carry out. */
  action: SiteAction | null;
  /** The action that was wanted but not carried out, or null. */
  offered: SiteAction | null;
  /** Why nothing was carried out, in words. Null when it was carried out. */
  reason: string | null;
}

/** The world the decision is made in. */
export interface ActionWorld {
  /** True while any wallet signature is open. */
  signatureOpen: boolean;
  /** True when the page really carries the element she pointed at. */
  pointExists: boolean;
}

export function decideAction(action: SiteAction, world: ActionWorld): ActionDecision {
  if (world.signatureOpen) {
    return {
      action: null,
      offered: action,
      reason: "a wallet signature is open, so the page stays where it is",
    };
  }

  if (action.kind === "point" && !world.pointExists) {
    return {
      action: null,
      offered: action,
      reason: "the page does not carry the element she pointed at",
    };
  }

  return { action, offered: null, reason: null };
}
