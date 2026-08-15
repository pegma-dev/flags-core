export interface ReleasePackageDefinition {
  readonly directory: string;
  readonly name: string;
}

export interface ValidationOptions {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly releasePrerelease?: boolean | string;
  readonly expectedReleaseCommit?: string;
  readonly requireClean?: boolean;
  readonly requireMainAncestor?: boolean;
  readonly requireReleaseTag?: boolean;
}

export interface ReleaseCommandOptions extends ValidationOptions {
  readonly manifest?: string;
  readonly output?: string;
}

export interface PublicPackageManifest {
  readonly name: string;
  readonly version: string;
  readonly [key: string]: unknown;
}

export interface ValidatedPackage {
  readonly definition: ReleasePackageDefinition;
  readonly manifest: PublicPackageManifest;
  readonly packageDirectory: string;
}

export interface ValidationResult {
  readonly root: string;
  readonly packages: readonly ValidatedPackage[];
  readonly releaseTag: string | undefined;
}

export interface PnpmImporterDependency {
  readonly specifier: string | null;
  readonly version: string | null;
}

export interface PnpmLockfileDependency {
  readonly specifier?: string;
  readonly version?: string;
}

export type PnpmLockfileImporters = Record<
  string,
  Record<string, Record<string, PnpmLockfileDependency>>
>;

export const RELEASE_PACKAGES: readonly ReleasePackageDefinition[];

export function decodeYamlScalar(raw: string): string;

export function parsePnpmImporterDependencies(
  block: string,
  section?: "dependencies" | "optionalDependencies" | "devDependencies",
): Map<string, PnpmImporterDependency>;

export function parsePnpmLockfileImporters(text: string): PnpmLockfileImporters;

export function lockfileResolvedIdentity(resolved: string): string;

export function lockResolvedVersion(version: string): string;

export function lockfileResolvedVersionMatches(
  resolved: string,
  specifier: string,
): boolean;

export function resolvedVersionSatisfies(
  version: string,
  specifier: string,
): boolean;

export function lockDependencyMatches(
  lockDependency: PnpmLockfileDependency | undefined,
  specifier: string,
  options?: { readonly workspace?: boolean },
): boolean;

export function parseNpmJson(stdout: string): unknown;

export function publicRegistryArguments(
  arguments_: readonly string[],
  registry?: string,
): string[];

export function parseArguments(
  arguments_: readonly string[],
): ReleaseCommandOptions;

export function validateRepository(
  options?: ValidationOptions,
): Promise<ValidationResult>;

export function validateReleaseTag(options?: {
  readonly root?: string;
  readonly releaseTag?: string;
  readonly expectedReleaseCommit?: string;
}): { headCommit: string; releaseTag: string };

export function decidePublication(
  localIntegrity: string,
  registryIntegrity: string | null,
): "publish" | "skip";

export function prepareRelease(
  options?: ReleaseCommandOptions,
): Promise<{ manifestPath: string; manifest: unknown }>;

export function publishPreparedRelease(
  options?: ReleaseCommandOptions,
): Promise<void>;
