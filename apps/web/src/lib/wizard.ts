/**
 * Sponsor-wizard validation, extracted from the page component.
 *
 * It lives in its own module so it can be unit-tested without rendering JSX, and
 * so the form and any future API share one rule set.
 */

export interface WizardValues {
  spec: string;
  testsCID: string;
  rewardEth: string;
  deadlineHours: string;
  breakWindowHours: string;
}

export const EMPTY_WIZARD: WizardValues = {
  spec: "",
  testsCID: "",
  rewardEth: "0.1",
  deadlineHours: "48",
  breakWindowHours: "12",
};

export const LIMITS = {
  rewardEth: 0.01,
  deadlineHours: 1,
  breakWindowHours: 1,
  breakWindowMaxHours: 168,
} as const;

export interface ValidationResult {
  ok: boolean;
  errors: Partial<Record<keyof WizardValues, string>>;
  bondEth: string;
}

/** CIDv0 (46 chars) or CIDv1 (59 chars). Mirrors the artifact schema. */
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58})$/;

export function validateWizard(v: WizardValues): ValidationResult {
  const errors: ValidationResult["errors"] = {};

  const spec = v.spec.trim();
  if (spec.length === 0) {
    errors.spec = 'Describe exactly what "done" means.';
  } else if (spec.length < 20) {
    errors.spec = "Vague specs get broken runs. Point at files, name the tests.";
  }

  if (!CID_RE.test(v.testsCID.trim())) {
    errors.testsCID = "That isn't a valid IPFS CID.";
  }

  const reward = Number(v.rewardEth);
  if (!Number.isFinite(reward) || reward < LIMITS.rewardEth) {
    errors.rewardEth = "Reward too small — the floor is 0.01 ETH.";
  }

  const deadline = Number(v.deadlineHours);
  if (!Number.isFinite(deadline) || deadline < LIMITS.deadlineHours) {
    errors.deadlineHours = "Deadline must be at least 1 hour out.";
  }

  const window = Number(v.breakWindowHours);
  if (
    !Number.isFinite(window) ||
    window < LIMITS.breakWindowHours ||
    window > LIMITS.breakWindowMaxHours
  ) {
    errors.breakWindowHours = "Skeptic window must be between 1 hour and 7 days.";
  }

  // mirrors CrucibleTrials.bondFor: 20% of reward, floor 0.01 ETH
  const rewardNum = Number.isFinite(reward) ? reward : 0;
  const bond = Math.max(0.01, rewardNum / 5);

  return { ok: Object.keys(errors).length === 0, errors, bondEth: bond.toFixed(4) };
}
