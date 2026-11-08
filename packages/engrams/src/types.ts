/**
 * @file types.ts — Engram domain types.
 *
 * An Engram is an earned achievement, never a client-side collectible.
 * Every entitlement must trace back to a verified event and a versioned rule.
 */

export type Rarity = "common" | "rare" | "epic" | "legendary";

export type AchievementEventType =
  | "trial.settled"
  | "trial.broken-survived"
  | "challenge.valid"
  | "reproducible"
  | "security.sentinel"
  | "research.accepted"
  | "season.champion";

export interface AchievementRule {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly rarity: Rarity;
  readonly qualifyingEvents: readonly AchievementEventType[];
  readonly requiredEvidence: readonly string[];
  readonly tokenId: number;
  readonly issuanceCap: number;
  readonly metadataDigest: string;
  readonly chainId: number;
  readonly revocationPolicy: "none" | "on-disqualification" | "on-reorg";
}

export interface VerifiedEvent {
  readonly eventId: string;
  readonly eventType: AchievementEventType;
  readonly trialId?: string;
  readonly runHash?: string;
  readonly reportDigest?: string;
  readonly agentId?: string;
  readonly operator?: string;
  readonly timestamp: number;
  readonly verified: boolean;
  readonly argusVerdict?: "paid" | "slashed" | "refunded";
}

export interface Entitlement {
  readonly entitlementId: string;
  readonly recipient: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly tokenId: number;
  readonly amount: number;
  readonly eventId: string;
  readonly evidenceRef: string;
  readonly issuedAt: number;
  readonly expiresAt?: number;
}

export interface EntitlementStore {
  has(entitlementId: string): boolean;
  add(e: Entitlement): void;
  listForRecipient(recipient: string): Entitlement[];
  countForRule(ruleId: string, ruleVersion: number): number;
}

export function newInMemoryEntitlementStore(): EntitlementStore {
  const items: Entitlement[] = [];
  const ids = new Set<string>();
  return {
    has(id) {
      return ids.has(id);
    },
    add(e) {
      if (ids.has(e.entitlementId)) {
        throw new Error(`entitlement already issued: ${e.entitlementId}`);
      }
      ids.add(e.entitlementId);
      items.push(e);
    },
    listForRecipient(recipient) {
      return items.filter((e) => e.recipient === recipient);
    },
    countForRule(ruleId, ruleVersion) {
      return items.filter((e) => e.ruleId === ruleId && e.ruleVersion === ruleVersion).length;
    },
  };
}

export function newAchievementRule(partial: Partial<AchievementRule> & Pick<AchievementRule, "id" | "version" | "name" | "qualifyingEvents" | "tokenId">): AchievementRule {
  return {
    ...partial,
    description: partial.description ?? "",
    rarity: partial.rarity ?? "common",
    requiredEvidence: partial.requiredEvidence ?? [],
    issuanceCap: partial.issuanceCap ?? 0,
    metadataDigest: partial.metadataDigest ?? "",
    chainId: partial.chainId ?? 1,
    revocationPolicy: partial.revocationPolicy ?? "on-disqualification",
  } as AchievementRule;
}
