import { describe, expect, it } from "vitest";
import {
  canTransition,
  canTransitionIn,
  forbiddenShortcuts,
  isTerminalState,
  nextStates,
} from "../src/state-machines.js";

describe("issuer readiness", () => {
  it("walks the happy path", () => {
    expect(canTransition("DRAFT", "COUNSEL_REVIEW")).toBe(true);
    expect(canTransition("COUNSEL_REVIEW", "ENTITY_READY")).toBe(true);
    expect(canTransition("ENTITY_READY", "IP_PERIMETER_VERIFIED")).toBe(true);
    expect(canTransition("IP_PERIMETER_VERIFIED", "META_DAO_REVIEW")).toBe(true);
    expect(canTransition("META_DAO_REVIEW", "LISTED")).toBe(true);
    expect(canTransition("LISTED", "ACTIVE")).toBe(true);
  });

  it("refuses to skip the legal perimeter", () => {
    expect(canTransition("DRAFT", "ACTIVE")).toBe(false);
    expect(canTransition("DRAFT", "META_DAO_REVIEW")).toBe(false);
  });

  it("treats the end states as terminal", () => {
    expect(isTerminalState("REJECTED")).toBe(true);
    expect(isTerminalState("WINDING_DOWN")).toBe(true);
    expect(isTerminalState("ACTIVE")).toBe(false);
  });
});

describe("instrument lifecycle", () => {
  it("walks signature to payment to funding", () => {
    expect(canTransitionIn("INSTRUMENT", "DRAFT", "COUNSEL_APPROVED")).toBe(true);
    expect(canTransitionIn("INSTRUMENT", "COUNSEL_APPROVED", "OFFERED")).toBe(true);
    expect(canTransitionIn("INSTRUMENT", "OFFERED", "SIGNED")).toBe(true);
    expect(canTransitionIn("INSTRUMENT", "SIGNED", "PAYMENT_PENDING")).toBe(true);
    expect(canTransitionIn("INSTRUMENT", "PAYMENT_PENDING", "FUNDED")).toBe(true);
  });

  it("never lets SIGNED mean FUNDED", () => {
    expect(canTransitionIn("INSTRUMENT", "SIGNED", "FUNDED")).toBe(false);
    expect(canTransitionIn("INSTRUMENT", "SIGNED", "DELIVERED")).toBe(false);
  });

  it("never lets FUNDED mean DELIVERED", () => {
    expect(canTransitionIn("INSTRUMENT", "FUNDED", "DELIVERED")).toBe(false);
  });

  it("requires a request and an approval before delivery", () => {
    expect(canTransitionIn("INSTRUMENT", "FUNDED", "ELIGIBLE_FOR_DELIVERY")).toBe(true);
    expect(canTransitionIn("INSTRUMENT", "ELIGIBLE_FOR_DELIVERY", "DELIVERY_REQUESTED")).toBe(true);
    expect(canTransitionIn("INSTRUMENT", "DELIVERY_REQUESTED", "DELIVERY_APPROVED")).toBe(true);
    expect(canTransitionIn("INSTRUMENT", "DELIVERY_APPROVED", "DELIVERED")).toBe(true);
  });

  it("keeps the terminal states terminal", () => {
    expect(isTerminalState("CANCELLED")).toBe(true);
    expect(isTerminalState("SUPERSEDED")).toBe(true);
    expect(isTerminalState("EXPIRED")).toBe(true);
    expect(nextStates("CANCELLED")).toEqual([]);
  });
});

describe("token structuring event", () => {
  it("requires the legal snapshot and the holder notice before the chain event", () => {
    expect(canTransition("PREPARATION", "LEGAL_SNAPSHOT_LOCKED")).toBe(true);
    expect(canTransition("LEGAL_SNAPSHOT_LOCKED", "HOLDER_NOTICE_SENT")).toBe(true);
    expect(canTransition("HOLDER_NOTICE_SENT", "META_DAO_EVENT_SUBMITTED")).toBe(true);
    expect(canTransition("META_DAO_EVENT_SUBMITTED", "CHAIN_CONFIRMED")).toBe(true);
    expect(canTransition("CHAIN_CONFIRMED", "FINALITY_CONFIRMED")).toBe(true);
    expect(canTransition("FINALITY_CONFIRMED", "PORTIONS_RECONCILED")).toBe(true);
    expect(canTransition("PORTIONS_RECONCILED", "DELIVERY_OPEN")).toBe(true);
  });

  it("refuses to skip the notice", () => {
    expect(canTransition("PREPARATION", "META_DAO_EVENT_SUBMITTED")).toBe(false);
  });
});

describe("delivery lifecycle", () => {
  it("walks the full path", () => {
    expect(canTransition("REQUESTED", "SIGNATURE_VERIFIED")).toBe(true);
    expect(canTransition("SIGNATURE_VERIFIED", "ADDRESS_VALIDATED")).toBe(true);
    expect(canTransition("ADDRESS_VALIDATED", "ELIGIBILITY_RECHECKED")).toBe(true);
    expect(canTransition("ELIGIBILITY_RECHECKED", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "SUBMITTED")).toBe(true);
    expect(canTransition("SUBMITTED", "CONFIRMED")).toBe(true);
    expect(canTransition("CONFIRMED", "RECONCILED")).toBe(true);
  });

  it("refuses to reconcile a submitted-but-unconfirmed transfer", () => {
    expect(canTransition("SUBMITTED", "RECONCILED")).toBe(false);
    expect(canTransition("APPROVED", "RECONCILED")).toBe(false);
  });

  it("rejects from any non-terminal state", () => {
    expect(canTransition("REQUESTED", "REJECTED")).toBe(true);
    expect(canTransition("SIGNATURE_VERIFIED", "REJECTED")).toBe(true);
  });
});

describe("forbidden shortcuts", () => {
  it("lists transitions that no machine allows", () => {
    for (const shortcut of forbiddenShortcuts()) {
      expect(canTransitionIn(shortcut.machine, shortcut.from, shortcut.to)).toBe(false);
    }
  });
});