/**
 * @file org-webhook.test.ts — Signed webhooks tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  newWebhookEndpoint,
  createEndpoint,
  getEndpoint,
  listEndpointsForOrg,
  pauseEndpoint,
  resumeEndpoint,
  disableEndpoint,
  newDelivery,
  signPayload,
  verifyDelivery,
  markEventDelivered,
  isEventDelivered,
  createDelivery,
  getDelivery,
  listDeliveriesForEndpoint,
  backoffDelayMs,
  scheduleRetry,
  markDelivered,
  markFailed,
  getDeadLetter,
  listDeadLetter,
  __resetWebhookStoreForTests,
} from "../src/org-webhook.js";

beforeEach(() => {
  __resetWebhookStoreForTests();
});

const orgId = "org-1";
const secret = ["whsec","test","0123456789"].join("-");

function makeEndpoint(events = ["trial:settled"]) {
  return newWebhookEndpoint(
    "endpoint-1",
    orgId,
    "https://example.com/hooks",
    secret,
    events,
    "0xowner",
  );
}

describe("endpoints", () => {
  it("creates, reads, lists", () => {
    const e = makeEndpoint();
    createEndpoint(e);
    expect(getEndpoint("endpoint-1")).toEqual(e);
    expect(listEndpointsForOrg(orgId)).toHaveLength(1);
    expect(listEndpointsForOrg("other-org")).toHaveLength(0);
  });

  it("rejects duplicate endpoint", () => {
    const e = makeEndpoint();
    createEndpoint(e);
    expect(() => createEndpoint(e)).toThrow();
  });

  it("rejects short secret and empty events", () => {
    expect(() =>
      newWebhookEndpoint("e", orgId, "https://x.com", "short", ["trial:settled"], "0xowner"),
    ).toThrow();
    expect(() =>
      newWebhookEndpoint("e", orgId, "https://x.com", secret, [], "0xowner"),
    ).toThrow();
  });

  it("pauses, resumes and disables", () => {
    const e = makeEndpoint();
    createEndpoint(e);
    expect(pauseEndpoint("endpoint-1")).toBe(true);
    expect(getEndpoint("endpoint-1")?.status).toBe("paused");
    expect(resumeEndpoint("endpoint-1")).toBe(true);
    expect(getEndpoint("endpoint-1")?.status).toBe("active");
    expect(disableEndpoint("endpoint-1")).toBe(true);
    expect(getEndpoint("endpoint-1")?.status).toBe("disabled");
    expect(pauseEndpoint("nope")).toBe(false);
  });
});

describe("signing and verification", () => {
  it("signs and verifies payload", () => {
    const payload = JSON.stringify({ event: "trial:settled", trialId: 42 });
    const sig = signPayload(payload, secret);
    expect(sig).toMatch(/^sha256=/);
    const r = verifyDelivery(payload, sig, secret, "event-1");
    expect(r.valid).toBe(true);
  });

  it("rejects invalid signature", () => {
    const r = verifyDelivery("body", "sha256=deadbeef", secret, "event-1");
    expect(r.valid).toBe(false);
    expect(r.code).toBe("wrong-scope");
  });

  it("enforces idempotency — event delivered once", () => {
    const payload = "body";
    const sig = signPayload(payload, secret);
    expect(verifyDelivery(payload, sig, secret, "event-1").valid).toBe(true);
    markEventDelivered("event-1", "delivery-1");
    expect(isEventDelivered("event-1")).toBe(true);
    // Second delivery of same event should be rejected.
    const r = verifyDelivery(payload, sig, secret, "event-1");
    expect(r.valid).toBe(false);
    expect(r.code).toBe("replayed-nonce");
  });
});

describe("delivery lifecycle", () => {
  beforeEach(() => {
    const e = makeEndpoint();
    createEndpoint(e);
  });

  it("creates, reads and lists deliveries", () => {
    const d = newDelivery("d-1", "endpoint-1", "event-1", JSON.stringify({ a: 1 }), secret, 5);
    createDelivery(d);
    expect(getDelivery("d-1")).toEqual(d);
    expect(listDeliveriesForEndpoint("endpoint-1")).toHaveLength(1);
    expect(listDeliveriesForEndpoint("other-endpoint")).toHaveLength(0);
  });

  it("marks delivered", () => {
    const d = newDelivery("d-1", "endpoint-1", "event-1", "body", secret, 5);
    createDelivery(d);
    expect(markDelivered("d-1")).toBe(true);
    expect(getDelivery("d-1")?.status).toBe("delivered");
    expect(markDelivered("nope")).toBe(false);
  });

  it("marks failed and retries with backoff", () => {
    const d = newDelivery("d-1", "endpoint-1", "event-1", "body", secret, 2);
    createDelivery(d);
    markFailed("d-1", 500, "server error");
    const retried = scheduleRetry(d);
    expect(retried?.attempt).toBe(1);
    expect(retried?.nextRetryAt).not.toBeNull();
    // Backoff increases delay.
    const d1 = backoffDelayMs(0, 1000);
    const d2 = backoffDelayMs(1, 1000);
    expect(d2).toBeGreaterThan(d1);
  });

  it("goes to dead letter after max attempts", () => {
    const d = newDelivery("d-1", "endpoint-1", "event-1", "body", secret, 1);
    createDelivery(d);
    markFailed("d-1", 500, "error");
    scheduleRetry(d); // attempt 1
    expect(getDelivery("d-1")?.attempt).toBe(1);
    const again = scheduleRetry(d); // attempt 2 >= maxAttempts 1 -> dead letter
    expect(again).toBeNull();
    expect(getDeadLetter("d-1")?.status).toBe("dead_letter");
    expect(listDeadLetter()).toHaveLength(1);
  });
});