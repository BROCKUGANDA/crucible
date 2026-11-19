// Value exports
export { splitBank, verifyPartition, isHoldout } from "./splits.js";
export {
  canTransition,
  nextStates,
  isTerminal,
  validateManifest,
  assertRunTransition,
  runStateForVerification,
  RunTransitionError,
} from "./workload-contracts.js";
export type { RunTransition } from "./workload-contracts.js";
export {
  validateEngineeringTask,
  requirementsForMode,
  SoftwareEngineeringAdapter,
  softwareEngineeringAdapter,
  ENGINEERING_RUBRIC,
  ENGINEERING_REQUIREMENTS,
  engineeringCheckIds,
  isEngineeringPass,
} from "./workload-software.js";
export {
  computeVerdict,
  scoreVerdict,
  checksDigest,
  withheldReasonFor,
  HARD_GATE_DIMENSIONS,
} from "./verification.js";
export type { CheckEvidence, RequiredCheck, VerificationInput, Verdict, ScoredResult } from "./verification.js";
export {
  normalisePatchPath,
  matchGlob,
  isTestPath,
  isHarnessPath,
  validatePatchPolicy,
  checkPatchPolicy,
  describePatchViolations,
} from "./patch-policy.js";
export type { ChangedFile, PatchPolicy, PatchPolicyResult, PatchViolation, PatchViolationCode } from "./patch-policy.js";
export {
  PIPELINE_STATES,
  PIPELINE_FAILURE_STATES,
  canTransitionPipeline,
  nextPipelineStates,
  assertPipelineTransition,
  isPipelineFailure,
  isTerminalPipelineState,
  failPipeline,
  canPublishOutput,
  PipelineTransitionError,
} from "./pipeline.js";
export type {
  PipelineState,
  PipelineFailureState,
  PipelineStatus,
  PipelineStep,
} from "./pipeline.js";
export {
  validateDataContract,
  checkRows,
  checkCompatibility,
  previewContract,
  StructuredDataAdapter,
  structuredDataAdapter,
  DATA_RUBRIC,
  DATA_REQUIREMENTS,
} from "./workload-data.js";
export type {
  DataContract as DataContractFull,
  FieldSpec,
  FieldType,
  RowCheckOptions,
  CompatibilityReport,
  PipelineEvidence,
} from "./workload-data.js";
export {
  validateMandate,
  riskCheck,
  dvpCheck,
  stablecoinPegCheck,
  quantChecks,
  canonicalIntentHash,
  approvalStillValid,
  preExecutionVerdict,
  emptyKillSwitches,
  engagedSwitch,
  AutonomousFinanceAdapter,
  autonomousFinanceAdapter,
  FINANCE_RUBRIC,
  FINANCE_REQUIREMENTS,
  MATERIAL_FIELDS,
} from "./workload-finance.js";
export type {
  MandateMode,
  KillSwitchState,
  RiskContext,
  HumanApproval,
  ApprovalCheck,
  FinanceEvidence,
  PreExecutionInput,
  PreExecutionVerdict,
} from "./workload-finance.js";
export {
  validateSolanaTask,
  anchorAuditChecks,
  SolanaEngineeringAdapter,
  solanaEngineeringAdapter,
  SOLANA_RUBRIC,
  SOLANA_REQUIREMENTS,
  ANCHOR_VULN_CLASSES,
} from "./workload-solana.js";
export {
  assertAllowedUrl,
  normaliseHttpError,
  parseRetryAfter,
  redactForLog,
  backoffMs,
  withRetry,
  ConnectorRateLimiter,
  validateCursorShape,
  pageSetDigest,
  planRead,
  ConnectorError,
} from "./connector.js";
export type {
  ConnectorCapabilities,
  ConnectorConfig,
  ConnectorErrorCode,
  ConnectionTest,
  DataConnector,
  ReadPage,
  ReadRequest,
  RetryPolicy,
  SecretReference,
} from "./connector.js";

export {
  startEvent,
  completeEvent,
  lineageGaps,
  validateRunEvent,
  eventDigest,
  LINEAGE_PRODUCER,
  LINEAGE_SCHEMA_URL,
} from "./lineage.js";
export type {
  DatasetFacet,
  DatasetIdentifier,
  JobFacet,
  ProvenanceInput,
  RunEvent,
  RunEventType,
  RunFacet,
} from "./lineage.js";

export { getAdapter, listAdapters } from "./workload.js";
export type { WorkloadKind } from "./workload.js";
export {
  trajectoryFromResult,
  trajectoryToJsonl,
  trajectoryFromJsonl,
  exportJsonl,
  parseJsonl,
  manifestHash,
} from "./trajectories.js";
export { bestOfN, writeResults, trainSplit } from "./train.js";
export { promptOptimize, exportWinner } from "./promote.js";
export {
  newForgeBrief,
  validateForgeBrief,
  newReadinessReport,
  computeBriefDigest,
  sealBrief,
} from "./forge-brief.js";
export {
  newTrialDifficultyProfile,
  emptyDifficultyDimensions,
  newAgentTrialFit,
  irtPassProbability,
  estimateDifficultyFromOutcomes,
  classifyHeat,
  computeAgentFit,
} from "./difficulty-profile.js";
export {
  newBountyRecommendation,
  newBountyAdequacyReport,
  calculateBondWei,
  calculateProtocolFeeWei,
  calculateNetAgentPayoutWei,
  computeBountyRecommendation,
  assessBountyAdequacy,
} from "./bounty-adequacy.js";
export {
  newForgeCampaign,
  addStage,
  fundStage,
  settleStage,
  isStageEligible,
  validateCampaign,
} from "./forge-campaign.js";

// Type exports
export type {
  WorkloadProfile,
  VerificationStatus,
  RunState,
  RunContext,
  ValidationReport,
  PreparedTask,
  ExecutionResult,
  VerificationReport,
  CheckResult,
  Scorecard,
  ArtifactRef,
  ExecutionManifest,
  WorkloadAdapter,
  VersionedRubric,
} from "./workload-contracts.js";
export type { EngineeringTaskPackage } from "./workload-software.js";
export type { DataContract } from "./workload-data.js";
export type {
  AutonomyLevel,
  FinanceMandate,
  OrderProposal,
  DvpLegs,
} from "./workload-finance.js";
export type { ProbeRecord, SplitResult } from "./splits.js";
export type { TrajectoryRecord } from "./trajectories.js";
export type {
  BestOfNConfig,
  BestOfNResult,
  Sampler,
  Scorer,
} from "./train.js";
export type {
  Candidate,
  ScorerFn,
  PromptOptimizeConfig,
  CandidateScore,
  PromptOptimizeResult,
} from "./promote.js";
export { defaultRating, conservative, trueskillWin, decayRating, tierFor, nodeStatus, DEFAULT_MU, DEFAULT_SIGMA } from './ratings.js'; 
export type { Rating, Tier, SkillNode, SkillState, NodeStatus } from './ratings.js'; 
export { compileDag, validateRoleContract, stepKey, appendMessage, verifyChain, validateSplits, shapley, collusionScore, claimOrder } from './orchestration.js';  
export type { SwarmRole, DagStep, RoleContract, BusMessage } from './orchestration.js';  
export { rankBoard, verifyRanking, coldStart, targetDifficulty, commissionInBand, applyCaps, circuitFrozen, gasInBand, lintRagDocs, retrieveAt, appendCheckpoint, verifyCheckpoints, abstentionScore, leafFor, merkleRoot, merkleProof, verifyMerkle, sybilAdjust, EventGateway, assertPiiFree, FEE_BPS_CANONICAL } from './gates.js';  
export type { BoardEntry, RagDoc, HoldoutFingerprint, Checkpoint, GatewayEvent, RankingExclusion, RankingResult } from './gates.js'; 
export type { ForgeBrief, ForgeBriefStatus, ForgeBriefObjective, ForgeBriefRequirement, ForgeBriefComplexity, ForgeBriefEnvironment, ForgeBriefVerification, ForgeBriefReliabilityAndRisk, ForgeBriefFinancialCommitment, ChallengeReadinessReport } from './forge-brief.js';
export type { TrialDifficultyProfile, DifficultyDimensions, DifficultyDimensionScore, DifficultyDimension, AgentTrialFit, AgentFitBucket, HeatClassification, TrialHeat } from './difficulty-profile.js';
export type { BountyRecommendation, BountyAdequacyReport } from './bounty-adequacy.js';
export type { ForgeCampaign, CampaignStage, CampaignStatus, StageStatus } from './forge-campaign.js';
