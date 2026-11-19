/**
 * @file metadao.ts — the MetaDAO adapter, capability-first.
 *
 * MetaDAO's own documentation says listing begins with an intake form and an
 * onboarding contact, and that automation is still being developed. There is no
 * stable public API contract for the STAMP steps, and the blueprint is blunt
 * about the consequence: do not invent one, do not scrape one, and do not
 * return a placeholder success for a capability that does not exist.
 *
 * So the adapter is an interface with an explicit capability answer, and the
 * only implementation that ships is the manual one. `UNSUPPORTED` is a real
 * answer that routes the caller to a signed, evidence-backed manual review. A
 * future documented API becomes a second implementation of the same interface
 * without touching any caller.
 */

export type CapabilityState = "SUPPORTED" | "UNSUPPORTED";

export interface MetaDaoCapabilities {
  projectLookup: CapabilityState;
  intakeSubmission: CapabilityState;
  tokenEventLookup: CapabilityState;
  treasuryLookup: CapabilityState;
  governanceLookup: CapabilityState;
  deliveryAutomation: CapabilityState;
  vestingAutomation: CapabilityState;
  /** The adapter's own version, so a stored snapshot names its producer. */
  adapterVersion: string;
}

export interface MetaDaoProjectSnapshot {
  projectRef: string;
  /** Everything below is what the reviewer recorded, with its source. */
  name: string | null;
  /** The approved receiving wallet, as confirmed by MetaDAO. */
  approvedWallet: string | null;
  approvedStablecoinMint: string | null;
  tokenMint: string | null;
  governanceUrl: string | null;
  saleUrl: string | null;
  /** Evidence for the snapshot: a source URL and an immutable hash. */
  evidence: EvidenceRecord[];
}

export interface CanonicalTokenEvent {
  eventRef: string;
  signature: string;
  slot: number;
  mint: string;
  totalSupply: string;
  finality: string;
  evidence: EvidenceRecord[];
}

export interface TreasurySnapshot {
  projectRef: string;
  address: string | null;
  balanceBaseUnits: string | null;
  mintAuthority: string | null;
  evidence: EvidenceRecord[];
}

export interface GovernanceLinks {
  decisionMarkets: string[];
  proposals: string[];
  evidence: EvidenceRecord[];
}

export interface EvidenceRecord {
  /** What the evidence is. */
  kind: "screenshot" | "url" | "email" | "signed-document" | "chain-observation" | "manual-note";
  uri: string;
  /** SHA-256 of the artefact, so a stored record names exactly one document. */
  sha256: string;
  /** The named reviewer who accepted it. */
  reviewer: string;
  /** When they accepted it. */
  recordedAt: string;
  /** Where it came from. */
  sourceUrl: string | null;
}

export interface MetaDaoAdapter {
  capabilities(): Promise<MetaDaoCapabilities>;
  getProject(projectRef: string): Promise<MetaDaoProjectSnapshot | { unsupported: true; reason: string }>;
  getCanonicalTokenEvent(eventRef: string): Promise<CanonicalTokenEvent | { unsupported: true; reason: string }>;
  getTreasurySnapshot(projectRef: string): Promise<TreasurySnapshot | { unsupported: true; reason: string }>;
  getGovernanceLinks(projectRef: string): Promise<GovernanceLinks | { unsupported: true; reason: string }>;
}

/** Is this answer a refusal to act? */
export function isUnsupported<T>(value: T | { unsupported: true; reason: string }): value is { unsupported: true; reason: string } {
  return typeof value === "object" && value !== null && "unsupported" in value && value.unsupported === true;
}

/**
 * The manual adapter: everything is recorded by a named reviewer against
 * evidence, and nothing is fetched automatically.
 *
 * `records` is a lookup the console populates through the admin API. An absent
 * record is `unsupported`, not "no project": the difference between "MetaDAO
 * has never confirmed this" and "MetaDAO confirmed there is no project" is the
 * difference between waiting and launching.
 */
export class ManualMetaDaoAdapter implements MetaDaoAdapter {
  constructor(
    private readonly records: {
      projects?: ReadonlyMap<string, MetaDaoProjectSnapshot>;
      tokenEvents?: ReadonlyMap<string, CanonicalTokenEvent>;
      treasuries?: ReadonlyMap<string, TreasurySnapshot>;
      governance?: ReadonlyMap<string, GovernanceLinks>;
    } = {},
  ) {}

  async capabilities(): Promise<MetaDaoCapabilities> {
    return {
      projectLookup: "SUPPORTED",
      intakeSubmission: "UNSUPPORTED",
      tokenEventLookup: "SUPPORTED",
      treasuryLookup: "SUPPORTED",
      governanceLookup: "SUPPORTED",
      deliveryAutomation: "UNSUPPORTED",
      vestingAutomation: "UNSUPPORTED",
      adapterVersion: "metadao-manual/1.0.0",
    };
  }

  async getProject(projectRef: string): Promise<MetaDaoProjectSnapshot | { unsupported: true; reason: string }> {
    const record = this.records.projects?.get(projectRef);
    if (!record) {
      return {
        unsupported: true,
        reason: `no reviewer-recorded MetaDAO project for ${projectRef}; automation is not available and no record exists`,
      };
    }
    return record;
  }

  async getCanonicalTokenEvent(
    eventRef: string,
  ): Promise<CanonicalTokenEvent | { unsupported: true; reason: string }> {
    const record = this.records.tokenEvents?.get(eventRef);
    if (!record) {
      return {
        unsupported: true,
        reason: `no reviewer-recorded token event for ${eventRef}; the chain event must be captured with evidence`,
      };
    }
    return record;
  }

  async getTreasurySnapshot(
    projectRef: string,
  ): Promise<TreasurySnapshot | { unsupported: true; reason: string }> {
    const record = this.records.treasuries?.get(projectRef);
    if (!record) {
      return {
        unsupported: true,
        reason: `no reviewer-recorded treasury snapshot for ${projectRef}; treasury reads are a read-only mirror`,
      };
    }
    return record;
  }

  async getGovernanceLinks(
    projectRef: string,
  ): Promise<GovernanceLinks | { unsupported: true; reason: string }> {
    const record = this.records.governance?.get(projectRef);
    if (!record) {
      return {
        unsupported: true,
        reason: `no reviewer-recorded governance links for ${projectRef}`,
      };
    }
    return record;
  }
}

/**
 * A manual record is only usable when it carries evidence from a named reviewer.
 *
 * This is the check that keeps "manual fallback" from becoming "unchecked
 * claim": a snapshot with no evidence, or evidence with no reviewer, is not a
 * confirmation.
 */
export function validateEvidence(records: readonly EvidenceRecord[]): string[] {
  const problems: string[] = [];
  if (records.length === 0) problems.push("no evidence attached");
  for (const record of records) {
    if (!record.reviewer.trim()) problems.push(`evidence ${record.uri} has no named reviewer`);
    if (!/^[0-9a-f]{64}$/i.test(record.sha256)) {
      problems.push(`evidence ${record.uri} does not carry a SHA-256 hash`);
    }
    if (!record.recordedAt) problems.push(`evidence ${record.uri} has no recorded timestamp`);
    if (record.kind === "url" && !record.sourceUrl) {
      problems.push(`evidence ${record.uri} is a URL with no source`);
    }
  }
  return problems;
}