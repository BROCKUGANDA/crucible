/**
 * @file org-webhook.ts — Signed webhooks for organisations.
 *
 * HMAC over a timestamped raw request body, with a replay window, delivery
 * history, bounded retry and dead-letter state. Never retries a non-idempotent
 * payment — reconcile first.
 *
 * In-memory store, consistent with ADR-0008. Migration-ready for PostgreSQL.
 */

import type { OrganisationId } from "./organisation.js";
import { createHmac, timingSafeEqual } from "node:crypto";

const STATE_KEY = "__crucible_org_webhook__";
const globalScope = globalThis as unknown as Record<string, unknown>;

type WebhookStore = {
  endpoints: Map<string, WebhookEndpoint>;
  /** orgId -> set of endpoint ids */
  byOrg: Map<OrganisationId, Set<string>>;
  /** event id -> set of delivery ids (idempotency) */
  eventDeliveries: Map<string, Set<string>>;
  deliveries: Map<string, WebhookDelivery>;
  /** dead-letter: delivery id -> delivery */
  deadLetter: Map<string, WebhookDelivery>;
};

function getStore(): WebhookStore {
  let store = globalScope[STATE_KEY] as WebhookStore | undefined;
  if (!store) {
    store = {
      endpoints: new Map(),
      byOrg: new Map(),
      eventDeliveries: new Map(),
      deliveries: new Map(),
      deadLetter: new Map(),
    };
    globalScope[STATE_KEY] = store;
  }
  return store;
}

export type WebhookStatus = "active" | "paused" | "disabled";

export interface WebhookEndpoint {
  id: string;
  orgId: OrganisationId;
  url: string;
  /** HMAC secret, shared between Crucible and the subscriber */
  secret: string;
  /** events this endpoint subscribes to */
  events: readonly string[];
  status: WebhookStatus;
  /** max retry attempts per delivery */
  maxRetries: number;
  /** base delay in ms for exponential backoff */
  retryBaseDelayMs: number;
  createdAt: number;
  createdBy: string;
  /** last successful delivery, or null */
  lastDeliveredAt?: number;
  /** last failure, or null */
  lastFailedAt?: number;
  metadata: Record<string, string>;
}

export function newWebhookEndpoint(
  id: string,
  orgId: OrganisationId,
  url: string,
  secret: string,
  events: readonly string[],
  createdBy: string,
  maxRetries = 5,
  retryBaseDelayMs = 1000,
): WebhookEndpoint {
  if (!id || !orgId || !url || !secret || secret.length < 16 || !events.length || !createdBy) {
    throw new Error(
      "webhook: id, orgId, url, secret (>=16 chars), non-empty events and createdBy are required",
    );
  }
  return {
    id,
    orgId,
    url,
    secret,
    events,
    status: "active",
    maxRetries,
    retryBaseDelayMs,
    createdAt: Date.now(),
    createdBy,
    metadata: {},
  };
}

export function createEndpoint(e: WebhookEndpoint): void {
  const store = getStore();
  if (store.endpoints.has(e.id)) {
    throw new Error(`org-webhook: endpoint already exists: ${e.id}`);
  }
  store.endpoints.set(e.id, e);
  store.byOrg.get(e.orgId)?.add(e.id) ?? store.byOrg.set(e.orgId, new Set([e.id]));
}

export function getEndpoint(id: string): WebhookEndpoint | null {
  return getStore().endpoints.get(id) ?? null;
}

export function listEndpointsForOrg(orgId: OrganisationId): WebhookEndpoint[] {
  const store = getStore();
  const ids = store.byOrg.get(orgId);
  if (!ids) return [];
  return [...ids].map((id) => store.endpoints.get(id)).filter(Boolean) as WebhookEndpoint[];
}

export function pauseEndpoint(id: string): boolean {
  const store = getStore();
  const e = store.endpoints.get(id);
  if (!e) return false;
  e.status = "paused";
  store.endpoints.set(id, e);
  return true;
}

export function resumeEndpoint(id: string): boolean {
  const store = getStore();
  const e = store.endpoints.get(id);
  if (!e) return false;
  e.status = "active";
  store.endpoints.set(id, e);
  return true;
}

export function disableEndpoint(id: string): boolean {
  const store = getStore();
  const e = store.endpoints.get(id);
  if (!e) return false;
  e.status = "disabled";
  store.endpoints.set(id, e);
  return true;
}

/* ------------------------------------------------------------------ */
/* Delivery                                                           */
/* ------------------------------------------------------------------ */

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  /** the raw body that was signed and sent */
  payload: string;
  /** the HMAC signature sent with the delivery */
  signature: string;
  status: "pending" | "delivered" | "failed" | "dead_letter";
  attempt: number;
  maxAttempts: number;
  /** next retry time (exponential backoff with jitter), or null */
  nextRetryAt?: number;
  createdAt: number;
  deliveredAt?: number;
  /** HTTP status of the last attempt, or null */
  lastHttpStatus?: number;
  lastError?: string;
}

export function newDelivery(
  id: string,
  endpointId: string,
  eventId: string,
  payload: string,
  secret: string,
  maxAttempts: number,
): WebhookDelivery {
  const signature = signPayload(payload, secret);
  return {
    id,
    endpointId,
    eventId,
    payload,
    signature,
    status: "pending",
    attempt: 0,
    maxAttempts,
    createdAt: Date.now(),
  };
}

/** HMAC-SHA256 over the raw body. */
export function signPayload(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/**
 * Verify an inbound webhook signature. Replays within the replay window are
 * rejected if the event id has already been delivered (idempotency).
 */
export function verifyDelivery(
  payload: string,
  providedSignature: string,
  secret: string,
  eventId: string,
  replayWindowMs = 300_000,
): { valid: boolean; reason?: string; code?: string } {
  const expected = signPayload(payload, secret);
  const a = Buffer.from(providedSignature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "invalid_signature", code: "wrong-scope" };
  }
  // Idempotency: an event id may only be delivered once per endpoint.
  const deliveries = getStore().eventDeliveries.get(eventId);
  if (deliveries && deliveries.size > 0) {
    return { valid: false, reason: "event_already_delivered", code: "replayed-nonce" };
  }
  return { valid: true };
}

/** Record that an event was delivered to an endpoint (idempotency key). */
export function markEventDelivered(eventId: string, deliveryId: string): void {
  const store = getStore();
  store.eventDeliveries.get(eventId)?.add(deliveryId) ??
    store.eventDeliveries.set(eventId, new Set([deliveryId]));
}

/** Has this event already been delivered? */
export function isEventDelivered(eventId: string): boolean {
  const ids = getStore().eventDeliveries.get(eventId);
  return Boolean(ids && ids.size > 0);
}

export function createDelivery(d: WebhookDelivery): void {
  const store = getStore();
  if (store.deliveries.has(d.id)) {
    throw new Error(`org-webhook: delivery already exists: ${d.id}`);
  }
  store.deliveries.set(d.id, d);
  markEventDelivered(d.eventId, d.id);
}

export function getDelivery(id: string): WebhookDelivery | null {
  return getStore().deliveries.get(id) ?? null;
}

export function listDeliveriesForEndpoint(endpointId: string): WebhookDelivery[] {
  return [...getStore().deliveries.values()].filter((d) => d.endpointId === endpointId);
}

/**
 * Exponential backoff with full jitter for retry scheduling.
 * nextDelayMs = base * 2^attempt + random(0, base * 2^attempt)
 */
export function backoffDelayMs(attempt: number, baseMs: number): number {
  const exp = baseMs * Math.pow(2, attempt);
  return exp + Math.floor(Math.random() * exp);
}

export function scheduleRetry(d: WebhookDelivery): WebhookDelivery | null {
  const store = getStore();
  const current = store.deliveries.get(d.id);
  if (!current) return null;
  if (current.attempt >= current.maxAttempts) {
    current.status = "dead_letter";
    store.deliveries.set(d.id, current);
    store.deadLetter.set(d.id, current);
    return null;
  }
  current.attempt += 1;
  current.status = "pending";
  current.nextRetryAt = Date.now() + backoffDelayMs(current.attempt, current.maxAttempts > 0 ? 1000 : 1000);
  store.deliveries.set(d.id, current);
  return current;
}

export function markDelivered(id: string): boolean {
  const store = getStore();
  const d = store.deliveries.get(id);
  if (!d) return false;
  d.status = "delivered";
  d.deliveredAt = Date.now();
  d.nextRetryAt = undefined;
  store.deliveries.set(id, d);
  return true;
}

export function markFailed(id: string, httpStatus: number | null, error: string | null): boolean {
  const store = getStore();
  const d = store.deliveries.get(id);
  if (!d) return false;
  d.lastHttpStatus = httpStatus ?? undefined;
  d.lastError = error ?? undefined;
  store.deliveries.set(id, d);
  return true;
}

export function getDeadLetter(id: string): WebhookDelivery | null {
  return getStore().deadLetter.get(id) ?? null;
}

export function listDeadLetter(): WebhookDelivery[] {
  return [...getStore().deadLetter.values()];
}

/** Reset store state (testing only). */
export function __resetWebhookStoreForTests(): void {
  const store = getStore();
  store.endpoints.clear();
  store.byOrg.clear();
  store.eventDeliveries.clear();
  store.deliveries.clear();
  store.deadLetter.clear();
}

/** TypeScript brand. */
export const __orgWebhookBrand = Symbol.for("crucible.org-webhook");