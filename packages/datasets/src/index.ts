export {
  createDataset,
  verifyDatasetId,
  verifyManifestIntegrity,
  datasetSize,
  type Dataset,
  type DatasetManifest,
  type Shard,
} from "./registry.js";
export {
  rowBucket,
  bucketToRole,
  assignSplits,
  roleCounts,
  rowsForRole,
  verifyPartition,
  createSplitEngine,
  thresholds,
  type SplitRole,
  type SplitAssignment,
  type SplitConfig,
  type SplitEngine,
  TRAIN_LIMIT,
  DEV_LIMIT,
  SPLIT_FUNCTION_VERSION,
} from "./splits.js";
export {
  type ModalityType,
  type ModalityPayload,
  type CanonicalRow,
  type DatasetBatch,
  batchChecksum,
  makeBatch,
} from "./canonical.js";
export {
  type Connector,
  type ConnectorConfig,
  ConnectorError,
  type ConnectorResult,
  type DatasetRef,
  isConnectorError,
  detectModality,
} from "./connectors/base.js";
export { ManualConnector, type ManualConfig } from "./connectors/manual.js";
export { HuggingFaceConnector, type HfConfig, type HfFile } from "./connectors/huggingface.js";
export { S3Connector, type S3Config, type S3Object } from "./connectors/s3.js";
export { IpfsConnector, type IpfsConfig } from "./connectors/ipfs.js";
export {
  runPipeline,
  type PipelineResult,
  type PipelineOptions,
} from "./pipeline.js";
export {
  probeSpecHash,
  materializeProbe,
  evaluateSymbolic,
  safeEval,
  type DerivationSpec,
  type ProbeSpec,
  type MaterializedProbe,
} from "./materialize.js";
export {
  checkLeakage,
  pipelineWithLeakageCheck,
  type LeakageResult,
  type LeakageViolation,
  type LeakageLinterConfig,
  DEFAULT_LEAKAGE_CONFIG,
} from "./linter.js";
