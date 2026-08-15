import type { PrincipalId } from "@pegma/spine";

/** JSON-compatible value a flag or attribute may carry. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Why a client returned this value. */
export type EvaluationReason =
  "TARGETING_MATCH" | "DEFAULT_FALLBACK" | "DISABLED" | "STALE_CACHE" | "ERROR";

export const EVALUATION_REASONS = [
  "TARGETING_MATCH",
  "DEFAULT_FALLBACK",
  "DISABLED",
  "STALE_CACHE",
  "ERROR",
] as const satisfies readonly EvaluationReason[];

/** Kind declared on a flag schema entry. */
export type FlagValueKind = "boolean" | "string" | "number" | "json";

/**
 * Who and where this evaluation is for.
 *
 * The host builds this per request. Clients never read ambient context.
 */
export interface EvaluationContext {
  readonly targetingKey: string;
  readonly principalId?: PrincipalId;
  readonly tenant?: string;
  readonly environment?: string;
  readonly attributes?: Readonly<Record<string, JsonValue>>;
}

/** Uniform result of one flag evaluation. */
export interface EvaluationDetail<T> {
  readonly flagKey: string;
  readonly value: T;
  readonly reason: EvaluationReason;
  readonly variant?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/** What a provider returns before the client applies its codec. */
export interface FlagResolution {
  readonly value: unknown;
  readonly reason: EvaluationReason;
  readonly variant?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface FlagResolutionRequest {
  readonly flagKey: string;
  readonly defaultValue: unknown;
  readonly kind: FlagValueKind;
  readonly context: EvaluationContext;
}

export interface FlagProviderCapabilities {
  readonly static: boolean;
  readonly streaming: boolean;
  readonly targeting: boolean;
}

export interface FlagChangeEvent {
  readonly providerName: string;
  readonly flagKey?: string;
}

/**
 * Vendor- or test-supplied evaluation backend.
 *
 * Targeting rules live here (or in an open standard the adapter wraps).
 * The core client never interprets a rule document.
 */
export interface FlagProvider {
  readonly name: string;
  capabilities(): FlagProviderCapabilities;
  resolve(request: FlagResolutionRequest): Promise<FlagResolution>;
  subscribe?(listener: (event: FlagChangeEvent) => void): () => void;
  close?(): void | Promise<void>;
}
