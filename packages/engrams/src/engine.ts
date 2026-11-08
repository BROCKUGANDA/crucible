/**
 * @file engine.ts — Achievement engine.
 *
 * Evaluates verified events against versioned rules and issues entitlements.
 * No client-side randomness, no browser clocks, no user-supplied scores.
 */

import type {
  AchievementRule,
  Entitlement,
  EntitlementStore,
  VerifiedEvent,
} from "./types.js";
import { newInMemoryEntitlementStore } from "./types.js";

export interface EvaluationResult {
  readonly issued: Entitlement[];
  readonly skipped: { eventId: string; ruleId: string; reason: string }[];
}

export class AchievementEngine {
  private readonly rules = new Map<string, AchievementRule>();
  private readonly store: EntitlementStore;

  constructor(store: EntitlementStore = newInMemoryEntitlementStore()) {
    this.store = store;
  }

  registerRule(rule: AchievementRule): void {
    const key = `${rule.id}@${rule.version}`;
    if (this.rules.has(key)) {
      throw new Error(`rule already registered: ${key}`);
    }
    this.rules.set(key, rule);
  }

  getRule(id: string, version: number): AchievementRule | undefined {
    return this.rules.get(`${id}@${version}`);
  }

  listRules(): AchievementRule[] {
    return [...this.rules.values()];
  }

  /**
   * Evaluate a verified event against all registered rules.
   * Issues entitlements for matching rules, subject to caps and dedup.
   */
  evaluate(event: VerifiedEvent, recipient: string): EvaluationResult {
    const issued: Entitlement[] = [];
    const skipped: EvaluationResult["skipped"] = [];

    if (!event.verified) {
      return { issued, skipped: [{ eventId: event.eventId, ruleId: "*", reason: "event not verified" }] };
    }

    for (const rule of this.rules.values()) {
      if (!rule.qualifyingEvents.includes(event.eventType)) {
        continue;
      }
      // Evidence check.
      const missing = rule.requiredEvidence.filter((e) => !hasEvidence(event, e));
      if (missing.length > 0) {
        skipped.push({ eventId: event.eventId, ruleId: rule.id, reason: `missing evidence: ${missing.join(",")}` });
        continue;
      }
      // Cap check.
      if (rule.issuanceCap > 0 && this.store.countForRule(rule.id, rule.version) >= rule.issuanceCap) {
        skipped.push({ eventId: event.eventId, ruleId: rule.id, reason: "issuance cap reached" });
        continue;
      }
      // Dedup: one entitlement per (recipient, rule, event).
      const dedupId = `${recipient}:${rule.id}@${rule.version}:${event.eventId}`;
      if (this.store.has(dedupId)) {
        skipped.push({ eventId: event.eventId, ruleId: rule.id, reason: "already issued" });
        continue;
      }
      const entitlement: Entitlement = {
        entitlementId: dedupId,
        recipient,
        ruleId: rule.id,
        ruleVersion: rule.version,
        tokenId: rule.tokenId,
        amount: 1,
        eventId: event.eventId,
        evidenceRef: evidenceRef(event),
        issuedAt: event.timestamp,
      };
      this.store.add(entitlement);
      issued.push(entitlement);
    }

    return { issued, skipped };
  }

  entitlementsFor(recipient: string): Entitlement[] {
    return this.store.listForRecipient(recipient);
  }
}

function hasEvidence(event: VerifiedEvent, evidence: string): boolean {
  switch (evidence) {
    case "runHash":
      return !!event.runHash;
    case "reportDigest":
      return !!event.reportDigest;
    case "trialId":
      return !!event.trialId;
    case "argusVerdict":
      return !!event.argusVerdict;
    case "agentId":
      return !!event.agentId;
    default:
      return false;
  }
}

function evidenceRef(event: VerifiedEvent): string {
  return event.runHash ?? event.reportDigest ?? event.eventId;
}
