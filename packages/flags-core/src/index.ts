export type {
  EvaluationContext,
  EvaluationDetail,
  EvaluationReason,
  FlagChangeEvent,
  FlagProvider,
  FlagProviderCapabilities,
  FlagResolution,
  FlagResolutionRequest,
  FlagValueKind,
  JsonValue,
} from "@pegma/flags-contracts";
export { EVALUATION_REASONS } from "@pegma/flags-contracts";

export {
  cacheIdentity,
  createFlagsClient,
  loggableError,
  type FlagsClient,
  type FlagsClientOptions,
} from "./client.js";
export {
  flagConformanceCases,
  type ConformanceCase,
  type ConformanceScenario,
} from "./conformance.js";
export {
  createFlagsHealthCheck,
  type FlagsHealthCheck,
  type FlagsHealthCheckOptions,
  type FlagsHealthCheckResult,
} from "./health.js";
export {
  declareFlags,
  flag,
  isJsonValue,
  type BooleanFlagOptions,
  type FlagDefinition,
  type FlagSchema,
  type FlagValueOf,
  type JsonFlagOptions,
  type NumberFlagOptions,
  type StringFlagOptions,
} from "./schema.js";
