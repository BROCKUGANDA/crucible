/**
 * @file index.ts — the STAMP domain barrel.
 *
 * Pure domain only: integer calculations, the Pacific calendar, the four state
 * machines, the notice schedule, the fail-closed gates, the assignment
 * algebra and the preflight manifest comparison. No database, no chain, no
 * HTTP. Everything here is deterministic and testable without a network, which
 * is what makes it usable as the check on the parts that do have one.
 */

export {
  INVESTOR_RESERVE_CAP_BPS,
  TEAM_ALLOCATION_MIN_BPS,
  TEAM_ALLOCATION_MAX_BPS,
  BPS_DENOMINATOR,
  ratableReduce,
  holderPortion,
  allocateSchedule2,
  teamAllocationStatus,
  reserveHeadroomBps,
  isMonotonic,
} from "./allocations.js";
export type {
  AllocationInput,
  AllocationSnapshot,
  AllocationResult,
  TeamAllocationStatus,
} from "./allocations.js";

export {
  monthlyReleaseVector,
  buildVestingSchedule,
  firstReleaseInstant,
  releaseInstant,
  vestingStateAt,
  reconcileVesting,
  describeFirstRelease,
  VESTING_MONTHS,
} from "./vesting.js";
export type {
  MonthlyRelease,
  VestingSchedule,
  VestingScheduleInput,
  VestingState,
  RemainderPolicy,
} from "./vesting.js";

export {
  PACIFIC_TIMEZONE,
  DEFAULT_PACIFIC_CUTOFF_HOUR,
  zonedParts,
  zonedDateKey,
  zonedDayOfWeek,
  zonedMidnightUtc,
  timeZoneOffsetMs,
  dayOfWeekFromKey,
  isBusinessDay,
  addBusinessDays,
  businessDaysBetween,
  pacificCutoff,
} from "./calendar.js";
export type { BusinessCalendarOptions, ZonedParts } from "./calendar.js";

export {
  resolveExpiration,
  TSE_EXPIRY_DAYS,
  DAYS_PER_YEAR,
} from "./expiration.js";
export type { ExpirationBasis, ExpirationInput, ExpirationResolution } from "./expiration.js";

export {
  buildNoticeSchedule,
  escalateOverdue,
  outstandingNotices,
  TOKEN_STRUCTURING_NOTICE_DAYS,
  EXPIRATION_WARNING_DAYS,
} from "./notices.js";
export type { NoticeType, NoticeStatus, NoticeRequirement, NoticeScheduleInput } from "./notices.js";

export {
  canTransition,
  canTransitionIn,
  issuerNextStates,
  instrumentNextStates,
  structuringNextStates,
  deliveryNextStates,
  nextStates,
  isTerminalState,
  forbiddenShortcuts,
  FUNDED_STATES,
  MACHINES,
} from "./state-machines.js";
export type {
  AnyState,
  IssuerReadinessState,
  InstrumentState,
  StructuringEventState,
  DeliveryState,
  MachineName,
} from "./state-machines.js";

export {
  findPlaceholders,
  insiderParity,
  ipPerimeterGaps,
  tokenomicsGate,
  paymentGate,
  deliveryGate,
  deliveryQuantityGate,
  availableDeliveryPortion,
  combineGates,
} from "./policies.js";
export type {
  GateReason,
  GateResult,
  LockUpSchedule,
  IpAsset,
  IpAssetStatus,
  AllocationGateInput,
  PaymentGateInput,
  DeliveryGateInput,
  DeliveryQuantityInput,
} from "./policies.js";

export { applyAssignment, verifyNoDoubleCount } from "./assignment.js";
export type { AllocationRow, Assignment, AssignmentResult } from "./assignment.js";

export { compareManifest, productionMayRun, COMPARED_FIELDS } from "./manifest.js";
export type {
  PreflightManifest,
  LiveConfiguration,
  ManifestComparison,
} from "./manifest.js";

export { canonicalJson, sha256Hex, sha256Bytes, calculationInputHash } from "./hash.js";