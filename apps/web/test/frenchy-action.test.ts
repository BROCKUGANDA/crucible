import { describe, expect, it } from "vitest";
import { decideAction } from "../src/lib/frenchy/action.js";
import { holdInteraction, interactionPending, releaseInteraction } from "../src/lib/interaction.js";

/**
 * What the browser does with what Frenchy asked for.
 *
 * Two rules, and the second one is the interesting one:
 *
 *   * a point at something the page does not carry is not carried out - the
 *     map and the page have drifted, and drifting is worth saying;
 *   * **a signature outranks a redirect.** The wallet's dialog belongs to the
 *     page that opened it, and navigating underneath it leaves a confirmed
 *     transaction with no receipt on screen. So while anything is being
 *     signed she speaks and offers instead of taking.
 */

const navigate = { kind: "navigate" as const, path: "/trials", why: "the open trials" };
const point = {
  kind: "point" as const,
  path: "/trials",
  point: "trial-table",
  why: "the table",
};

describe("deciding what to do", () => {
  it("carries out a navigation", () => {
    const decision = decideAction(navigate, { signatureOpen: false, pointExists: false });
    expect(decision.action).toEqual(navigate);
    expect(decision.offered).toBeNull();
    expect(decision.reason).toBeNull();
  });

  it("carries out a point when the page carries it", () => {
    const decision = decideAction(point, { signatureOpen: false, pointExists: true });
    expect(decision.action).toEqual(point);
    expect(decision.offered).toBeNull();
  });

  it("does not carry out a point the page does not carry", () => {
    const decision = decideAction(point, { signatureOpen: false, pointExists: false });
    expect(decision.action).toBeNull();
    expect(decision.offered).toEqual(point);
    expect(decision.reason).toMatch(/does not carry/);
  });

  it("offers instead of moving while a signature is open", () => {
    const decision = decideAction(navigate, { signatureOpen: true, pointExists: false });
    expect(decision.action).toBeNull();
    expect(decision.offered).toEqual(navigate);
    expect(decision.reason).toMatch(/signature/);
  });

  it("offers a point rather than pointing at nothing", () => {
    const decision = decideAction(point, { signatureOpen: true, pointExists: true });
    expect(decision.action).toBeNull();
    expect(decision.offered).toEqual(point);
  });
});

describe("the count of open signatures", () => {
  it("is idle to begin with", () => {
    // The counter is module state, so a test that leaves it held would make
    // every later test in this file lie. It is released at the end.
    while (interactionPending()) releaseInteraction();
    expect(interactionPending()).toBe(false);
  });

  it("counts a signature that is open", () => {
    holdInteraction();
    expect(interactionPending()).toBe(true);
    releaseInteraction();
    expect(interactionPending()).toBe(false);
  });

  it("counts two signatures that overlap", () => {
    holdInteraction();
    holdInteraction();
    expect(interactionPending()).toBe(true);
    releaseInteraction();
    expect(interactionPending()).toBe(true);
    releaseInteraction();
    expect(interactionPending()).toBe(false);
  });

  it("never goes below zero", () => {
    // A stray release must not make the site look idle while a signature is
    // open, which is the one state where moving the page would hurt.
    releaseInteraction();
    releaseInteraction();
    expect(interactionPending()).toBe(false);
    holdInteraction();
    expect(interactionPending()).toBe(true);
    releaseInteraction();
    expect(interactionPending()).toBe(false);
  });
});
