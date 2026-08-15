import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_URL = "git+https://github.com/pegma-dev/flags-core.git";
const NODE_RANGE = ">=22";
const REVIEWED_PNPM_VERSION = "10.34.5";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const LOCKFILE_PIN_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
];

/** Public packages in dependency order (contracts before consumers). */
export const RELEASE_PACKAGES = [
  {
    directory: "flags-contracts",
    name: "@pegma/flags-contracts",
  },
  {
    directory: "flags-core",
    name: "@pegma/flags-core",
  },
  {
    directory: "flags-static",
    name: "@pegma/flags-static",
  },
  {
    directory: "flags-azure-appconfig",
    name: "@pegma/flags-azure-appconfig",
  },
  {
    directory: "flags-aws-appconfig",
    name: "@pegma/flags-aws-appconfig",
  },
  {
    directory: "flags-cloudflare-flagship",
    name: "@pegma/flags-cloudflare-flagship",
  },
  {
    directory: "flags-launchdarkly",
    name: "@pegma/flags-launchdarkly",
  },
];

const RELEASE_NAMES = new Set(RELEASE_PACKAGES.map(({ name }) => name));

function fail(message) {
  throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: options.shell ?? false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    fail(
      `${command} ${arguments_.join(" ")} failed with exit code ${String(result.status)}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return result;
}

function runPnpm(arguments_, options = {}) {
  return run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", arguments_, {
    ...options,
    shell: process.platform === "win32",
  });
}

function npmEnvironment(env) {
  const next = { ...env };
  delete next.npm_execpath;
  return next;
}

function runNpm(arguments_, options = {}) {
  return run(process.platform === "win32" ? "npm.cmd" : "npm", arguments_, {
    ...options,
    env: npmEnvironment(options.env ?? process.env),
    shell: process.platform === "win32",
  });
}

function gitCommand() {
  return process.platform === "win32" ? "git.exe" : "git";
}

function hashTarball(bytes) {
  return {
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

function exportTargets(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
}

function exportSpecifiers(manifest) {
  if (
    manifest.exports === null ||
    typeof manifest.exports !== "object" ||
    Array.isArray(manifest.exports)
  ) {
    fail(`${manifest.name} must declare object-form exports`);
  }
  return Object.keys(manifest.exports).map((key) =>
    key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`,
  );
}

export function decodeYamlScalar(raw) {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

export function parsePnpmImporterDependencies(block, section = "dependencies") {
  const dependencies = new Map();
  let current = null;
  let inSection = false;
  for (const line of block.split("\n")) {
    if (line === `    ${section}:`) {
      inSection = true;
      current = null;
      continue;
    }
    if (inSection && /^    \S/u.test(line)) {
      break;
    }
    if (!inSection) {
      continue;
    }
    const name = /^      (.+):$/u.exec(line);
    if (name !== null) {
      current = decodeYamlScalar(name[1]);
      dependencies.set(current, { specifier: null, version: null });
      continue;
    }
    if (current === null) {
      continue;
    }
    const specifier = /^        specifier: (.+)$/u.exec(line);
    if (specifier !== null) {
      dependencies.get(current).specifier = decodeYamlScalar(specifier[1]);
      continue;
    }
    const version = /^        version: (.+)$/u.exec(line);
    if (version !== null) {
      dependencies.get(current).version = decodeYamlScalar(version[1]);
    }
  }
  return dependencies;
}

export function parsePnpmLockfileImporters(text) {
  const importers = {};
  let inImporters = false;
  let currentPath = null;
  let currentSection = null;
  let currentDep = null;

  for (const line of text.split(/\r?\n/u)) {
    if (!inImporters) {
      if (line === "importers:") {
        inImporters = true;
      }
      continue;
    }
    if (line.length > 0 && !line.startsWith(" ") && line.endsWith(":")) {
      break;
    }
    if (line.trim() === "") {
      continue;
    }

    const importerMatch = /^ {2}(\S[^:]*):$/u.exec(line);
    if (importerMatch !== null) {
      currentPath = decodeYamlScalar(importerMatch[1]);
      importers[currentPath] = {};
      currentSection = null;
      currentDep = null;
      continue;
    }

    const sectionMatch =
      /^ {4}(dependencies|devDependencies|optionalDependencies|peerDependencies):$/u.exec(
        line,
      );
    if (sectionMatch !== null && currentPath !== null) {
      currentSection = sectionMatch[1];
      importers[currentPath][currentSection] = {};
      currentDep = null;
      continue;
    }

    const depMatch = /^ {6}([^:]+):$/u.exec(line);
    if (depMatch !== null && currentPath !== null && currentSection !== null) {
      currentDep = decodeYamlScalar(depMatch[1]);
      importers[currentPath][currentSection][currentDep] = {};
      continue;
    }

    const fieldMatch = /^ {8}(specifier|version): (.+)$/u.exec(line);
    if (
      fieldMatch !== null &&
      currentPath !== null &&
      currentSection !== null &&
      currentDep !== null
    ) {
      importers[currentPath][currentSection][currentDep][fieldMatch[1]] =
        decodeYamlScalar(fieldMatch[2]);
    }
  }
  return importers;
}

function parseSemverTriple(version) {
  const match = STABLE_SEMVER.exec(version);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseVersionFloor(raw) {
  const full = parseSemverTriple(raw);
  if (full !== null) {
    return { triple: full, parts: 3 };
  }
  const majorMinor = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(raw);
  if (majorMinor !== null) {
    return {
      triple: [Number(majorMinor[1]), Number(majorMinor[2]), 0],
      parts: 2,
    };
  }
  const major = /^(0|[1-9]\d*)$/u.exec(raw);
  if (major !== null) {
    return { triple: [Number(major[1]), 0, 0], parts: 1 };
  }
  return null;
}

function compareSemver(left, right) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function caretUpperBound(floor) {
  const [major, minor, patch] = floor.triple;
  if (floor.parts === 1) {
    return [major + 1, 0, 0];
  }
  if (floor.parts === 2) {
    if (major > 0) {
      return [major + 1, 0, 0];
    }
    return [0, minor + 1, 0];
  }
  if (major > 0) {
    return [major + 1, 0, 0];
  }
  if (minor > 0) {
    return [0, minor + 1, 0];
  }
  return [0, 0, patch + 1];
}

function tildeUpperBound([major, minor]) {
  return [major, minor + 1, 0];
}

function inHalfOpenRange(resolved, lower, upper) {
  return (
    compareSemver(resolved, lower) >= 0 && compareSemver(resolved, upper) < 0
  );
}

export function lockfileResolvedIdentity(resolved) {
  const suffix = resolved.indexOf("(");
  return suffix === -1 ? resolved : resolved.slice(0, suffix);
}

export function lockResolvedVersion(version) {
  return lockfileResolvedIdentity(version);
}

export function lockfileResolvedVersionMatches(resolved, specifier) {
  const resolvedId = lockfileResolvedIdentity(resolved);
  if (resolvedId === specifier) {
    return true;
  }
  const caret = /^\^(.+)$/u.exec(specifier);
  const tilde = /^~(.+)$/u.exec(specifier);
  if (caret === null && tilde === null) {
    return false;
  }
  const resolvedTriple = parseSemverTriple(resolvedId);
  if (resolvedTriple === null) {
    return false;
  }
  if (caret !== null) {
    const floor = parseVersionFloor(caret[1]);
    if (floor === null) {
      return false;
    }
    return inHalfOpenRange(
      resolvedTriple,
      floor.triple,
      caretUpperBound(floor),
    );
  }
  const floor = parseSemverTriple(tilde[1]);
  if (floor === null) {
    return false;
  }
  return inHalfOpenRange(resolvedTriple, floor, tildeUpperBound(floor));
}

export function resolvedVersionSatisfies(version, specifier) {
  if (EXACT_VERSION.test(specifier)) {
    return version === specifier || version.startsWith(`${specifier}(`);
  }
  return lockfileResolvedVersionMatches(version, specifier);
}

export function lockDependencyMatches(lockDependency, specifier, options = {}) {
  if (
    lockDependency === undefined ||
    lockDependency.specifier !== specifier ||
    typeof lockDependency.version !== "string" ||
    lockDependency.version.length === 0
  ) {
    return false;
  }
  if (options.workspace === true) {
    return lockDependency.version.startsWith("link:");
  }
  return resolvedVersionSatisfies(lockDependency.version, specifier);
}

export function validateReleaseTag(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedReleaseCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag === undefined || !/^v\d+\.\d+\.\d+$/u.test(releaseTag)) {
    fail("a stable release tag is required");
  }
  if (
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedReleaseCommit)
  ) {
    fail("an exact release event commit is required");
  }

  const tagRef = `refs/tags/${releaseTag}`;
  const type = run(gitCommand(), ["cat-file", "-t", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (type.status !== 0 || type.stdout.trim() !== "tag") {
    fail("the release ref must be an annotated tag object");
  }
  const headCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  const tagCommit = run(gitCommand(), ["rev-parse", `${tagRef}^{commit}`], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  if (
    !safeEqual(headCommit, tagCommit) ||
    !safeEqual(headCommit, expectedReleaseCommit)
  ) {
    fail(
      "the release checkout, signed tag target, and release event commit must match",
    );
  }
  const signature = run(gitCommand(), ["verify-tag", "--raw", tagRef], {
    cwd: root,
    capture: true,
    allowFailure: true,
  });
  if (signature.status !== 0) {
    fail("the release tag signature is not valid for an approved signer");
  }
  const onMain = run(
    gitCommand(),
    ["merge-base", "--is-ancestor", tagCommit, "refs/remotes/origin/main"],
    { cwd: root, capture: true, allowFailure: true },
  );
  if (onMain.status !== 0) {
    fail("the release tag commit must be contained in origin/main");
  }
  return { headCommit, releaseTag };
}

async function validatePackage(root, definition, lockfile) {
  const packageDirectory = join(root, "packages", definition.directory);
  const manifest = await readJson(join(packageDirectory, "package.json"));
  if (manifest.name !== definition.name) {
    fail(`expected ${definition.name} in packages/${definition.directory}`);
  }
  if (!STABLE_SEMVER.test(manifest.version)) {
    fail(`${definition.name} must use a stable semantic version`);
  }
  if (
    manifest.private === true ||
    manifest.license !== "MIT" ||
    manifest.type !== "module" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.engines?.node !== NODE_RANGE ||
    manifest.repository?.type !== "git" ||
    manifest.repository?.url !== REPOSITORY_URL ||
    manifest.repository?.directory !== `packages/${definition.directory}`
  ) {
    fail(`${definition.name} has invalid public package metadata`);
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.some((entry) => !entry.startsWith("dist/"))
  ) {
    fail(`${definition.name} must publish only its dist allowlist`);
  }
  if (
    typeof manifest.scripts?.prepack !== "string" ||
    !manifest.scripts.prepack.includes("build")
  ) {
    fail(`${definition.name} must build during prepack`);
  }
  const targets = exportTargets(manifest.exports);
  if (
    targets.length === 0 ||
    targets.some(
      (target) =>
        typeof target !== "string" ||
        !target.startsWith("./dist/") ||
        target.includes(".."),
    )
  ) {
    fail(`${definition.name} exports must point into dist`);
  }
  await stat(join(packageDirectory, "README.md"));
  await stat(join(packageDirectory, "LICENSE"));

  const lockEntry = lockfile[`packages/${definition.directory}`];
  if (lockEntry === undefined || typeof lockEntry !== "object") {
    fail(
      `${definition.name} is missing from pnpm-lock.yaml workspace inventory`,
    );
  }
  for (const section of LOCKFILE_PIN_SECTIONS) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      const workspace = RELEASE_NAMES.has(name);
      if (workspace) {
        const dependency = RELEASE_PACKAGES.find(
          (entry) => entry.name === name,
        );
        const dependencyManifest = await readJson(
          join(root, "packages", dependency.directory, "package.json"),
        );
        if (version !== dependencyManifest.version) {
          fail(
            `${definition.name} must pin ${name} to its exact workspace version`,
          );
        }
      }
      if (
        !lockDependencyMatches(lockEntry[section]?.[name], version, {
          workspace,
        })
      ) {
        fail(
          workspace
            ? `${definition.name} must pin ${name} to its exact workspace version`
            : `${definition.name} ${name}@${version} is not synchronized with pnpm-lock.yaml`,
        );
      }
    }
  }
  return { definition, manifest, packageDirectory };
}

async function publicWorkspaceInventory(root) {
  const directories = await readdir(join(root, "packages"), {
    withFileTypes: true,
  });
  const names = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) {
      continue;
    }
    const manifestPath = join(root, "packages", directory.name, "package.json");
    try {
      const manifest = await readJson(manifestPath);
      if (manifest.private !== true) {
        names.push(manifest.name);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return names.sort();
}

export async function validateRepository(options = {}) {
  const root = resolve(options.root ?? defaultRoot());
  const rootManifest = await readJson(join(root, "package.json"));
  if (
    rootManifest.private !== true ||
    rootManifest.packageManager !== `pnpm@${REVIEWED_PNPM_VERSION}`
  ) {
    fail(`the private root must pin pnpm@${REVIEWED_PNPM_VERSION}`);
  }
  const expectedInventory = RELEASE_PACKAGES.map(({ name }) => name).sort();
  const actualInventory = await publicWorkspaceInventory(root);
  if (!sameJson(actualInventory, expectedInventory)) {
    fail("public workspace inventory does not match the reviewed release list");
  }
  const lockfile = parsePnpmLockfileImporters(
    await readFile(join(root, "pnpm-lock.yaml"), "utf8"),
  );
  const packages = [];
  for (const definition of RELEASE_PACKAGES) {
    packages.push(await validatePackage(root, definition, lockfile));
  }

  if (options.requireClean) {
    const status = run(gitCommand(), ["status", "--porcelain"], {
      cwd: root,
      capture: true,
    }).stdout;
    if (status.trim() !== "") {
      fail("release preparation requires a clean checkout");
    }
  }
  if (options.requireMainAncestor) {
    const head = run(gitCommand(), ["rev-parse", "HEAD"], {
      cwd: root,
      capture: true,
    }).stdout.trim();
    const onMain = run(
      gitCommand(),
      ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"],
      { cwd: root, capture: true, allowFailure: true },
    );
    if (onMain.status !== 0) {
      fail("release commit must be contained in origin/main");
    }
  }

  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag !== undefined) {
    if (!/^v\d+\.\d+\.\d+$/u.test(releaseTag)) {
      fail("release tag must be a stable vX.Y.Z tag");
    }
    const version = releaseTag.slice(1);
    if (!packages.some(({ manifest }) => manifest.version === version)) {
      fail(
        `release tag ${releaseTag} does not match any public package version`,
      );
    }
    const prerelease =
      options.releasePrerelease ?? process.env.RELEASE_PRERELEASE ?? false;
    if (prerelease === true || prerelease === "true") {
      fail("prereleases cannot publish packages");
    }
  }
  if (options.requireReleaseTag) {
    validateReleaseTag({
      root,
      releaseTag,
      expectedReleaseCommit: options.expectedReleaseCommit,
    });
  }
  return { root, packages, releaseTag };
}

function verifyPackedFiles(manifest, files) {
  const paths = files.map(({ path }) => path);
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!paths.includes(required)) {
      fail(`${manifest.name} tarball is missing ${required}`);
    }
  }
  if (
    paths.some(
      (path) =>
        !["package.json", "README.md", "LICENSE"].includes(path) &&
        !path.startsWith("dist/"),
    )
  ) {
    fail(
      `${manifest.name} tarball contains a file outside the reviewed allowlist`,
    );
  }
  for (const target of exportTargets(manifest.exports)) {
    const path = target.replace(/^\.\//u, "");
    if (!paths.includes(path)) {
      fail(`${manifest.name} tarball is missing exported file ${path}`);
    }
  }
}

async function smokeTestTarballs(packageRecords) {
  const directory = await mkdtemp(join(tmpdir(), "flags-core-release-smoke-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      '{"name":"flags-core-release-smoke","private":true,"type":"module"}\n',
    );
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        ...packageRecords.map(({ tarballPath }) => tarballPath),
      ],
      { cwd: directory, capture: true },
    );
    for (const { manifest } of packageRecords) {
      for (const specifier of exportSpecifiers(manifest)) {
        run(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `await import(${JSON.stringify(specifier)})`,
          ],
          { cwd: directory, capture: true },
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function queryRegistryIntegrity(name, version) {
  const spec = `${name}@${version}`;
  const result = runNpm(["view", spec, "dist.integrity", "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (result.status === 0) {
    const integrity = JSON.parse(result.stdout);
    if (typeof integrity !== "string" || integrity.length === 0) {
      fail(`${spec} exists without dist.integrity`);
    }
    return integrity;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bE404\b/u.test(output)) {
    return null;
  }
  fail(`npm registry lookup failed for ${spec}:\n${output.trim()}`);
}

export function decidePublication(localIntegrity, registryIntegrity) {
  if (registryIntegrity === null) {
    return "publish";
  }
  if (safeEqual(localIntegrity, registryIntegrity)) {
    return "skip";
  }
  fail("the registry version exists with different tarball integrity");
}

export async function prepareRelease(options = {}) {
  const { root, packages, releaseTag } = await validateRepository(options);
  const gitCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: root,
    capture: true,
  }).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(gitCommit)) {
    fail(`git returned an invalid commit SHA: ${gitCommit}`);
  }
  const output = resolve(root, options.output ?? ".release");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) {
    fail(`release output directory must be empty: ${output}`);
  }

  runPnpm(["run", "build"], { cwd: root });
  const records = [];
  const tagVersion = releaseTag?.slice(1);
  for (const { definition, manifest } of packages) {
    const result = runNpm(
      [
        "pack",
        join(root, "packages", definition.directory),
        "--json",
        "--pack-destination",
        output,
      ],
      { cwd: root, capture: true },
    );
    const [packed] = JSON.parse(result.stdout);
    if (
      packed?.name !== definition.name ||
      packed?.version !== manifest.version ||
      typeof packed.filename !== "string" ||
      !Array.isArray(packed.files)
    ) {
      fail(`npm pack returned invalid metadata for ${definition.name}`);
    }
    verifyPackedFiles(manifest, packed.files);
    const tarballPath = join(output, basename(packed.filename));
    const hashes = hashTarball(await readFile(tarballPath));
    if (
      !safeEqual(hashes.integrity, packed.integrity) ||
      !safeEqual(hashes.shasum, packed.shasum)
    ) {
      fail(`${definition.name} tarball hashes do not match npm pack metadata`);
    }
    records.push({
      name: definition.name,
      version: manifest.version,
      directory: definition.directory,
      tarball: basename(tarballPath),
      tarballPath,
      integrity: hashes.integrity,
      shasum: hashes.shasum,
      publish: tagVersion === undefined || manifest.version === tagVersion,
      files: packed.files
        .map(({ path, size }) => ({ path, size }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      manifest,
    });
  }
  await smokeTestTarballs(records);

  if (releaseTag !== undefined) {
    for (const record of records.filter(({ publish }) => !publish)) {
      const registryIntegrity = queryRegistryIntegrity(
        record.name,
        record.version,
      );
      if (
        registryIntegrity === null ||
        !safeEqual(record.integrity, registryIntegrity)
      ) {
        fail(
          `${record.name}@${record.version} is not selected by ${releaseTag} and must exactly match npm`,
        );
      }
    }
  }

  const manifest = {
    schemaVersion: 1,
    gitCommit,
    releaseTag: releaseTag ?? null,
    packages: records.map(
      ({ tarballPath, manifest: _manifest, ...record }) => record,
    ),
  };
  const manifestPath = join(output, "package-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, manifest };
}

async function verifyPreparedManifest(manifestPath) {
  const manifest = await readJson(manifestPath);
  if (
    manifest.schemaVersion !== 1 ||
    !/^[0-9a-f]{40,64}$/u.test(manifest.gitCommit) ||
    !/^v\d+\.\d+\.\d+$/u.test(manifest.releaseTag) ||
    !Array.isArray(manifest.packages) ||
    !sameJson(
      manifest.packages.map(({ name }) => name),
      RELEASE_PACKAGES.map(({ name }) => name),
    )
  ) {
    fail("prepared package manifest has an invalid package inventory");
  }
  const currentCommit = run(gitCommand(), ["rev-parse", "HEAD"], {
    cwd: defaultRoot(),
    capture: true,
  }).stdout.trim();
  if (!safeEqual(currentCommit, manifest.gitCommit)) {
    fail("prepared package manifest commit does not match the checkout");
  }
  const tagVersion = manifest.releaseTag.slice(1);
  if (!manifest.packages.some(({ publish }) => publish)) {
    fail("prepared package manifest has no release candidates");
  }
  for (const [index, record] of manifest.packages.entries()) {
    const definition = RELEASE_PACKAGES[index];
    const expectedTarball = `${definition.name
      .slice(1)
      .replace("/", "-")}-${record.version}.tgz`;
    if (
      record.directory !== definition.directory ||
      record.tarball !== expectedTarball ||
      !STABLE_SEMVER.test(record.version) ||
      record.publish !== (record.version === tagVersion) ||
      typeof record.integrity !== "string" ||
      typeof record.shasum !== "string" ||
      !Array.isArray(record.files)
    ) {
      fail(`${record.name} has invalid prepared metadata`);
    }
    const tarball = resolve(dirname(manifestPath), record.tarball);
    if (dirname(tarball) !== resolve(dirname(manifestPath))) {
      fail(`${record.name} tarball must be beside the package manifest`);
    }
    const hashes = hashTarball(await readFile(tarball));
    if (
      !safeEqual(hashes.integrity, record.integrity) ||
      !safeEqual(hashes.shasum, record.shasum)
    ) {
      fail(`${record.name} prepared tarball has changed`);
    }
  }
  return manifest;
}

function requireTrustedPublishingNpm() {
  const version = runNpm(["--version"], { capture: true }).stdout.trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/u.exec(version);
  if (match === null) {
    fail(`could not parse npm version ${version}`);
  }
  const [, majorText, minorText, patchText] = match;
  const [major, minor, patch] = [majorText, minorText, patchText].map(Number);
  if (
    major < 11 ||
    (major === 11 && minor < 5) ||
    (major === 11 && minor === 5 && patch < 1)
  ) {
    fail("trusted publishing requires npm 11.5.1 or newer");
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function confirmRegistryIntegrity(record) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const integrity = queryRegistryIntegrity(record.name, record.version);
    if (integrity !== null && safeEqual(record.integrity, integrity)) {
      return;
    }
    if (attempt < 5) {
      wait(2 ** attempt * 1000);
    }
  }
  fail(
    `${record.name}@${record.version} did not become visible with the prepared integrity`,
  );
}

export async function publishPreparedRelease(options = {}) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_EVENT_NAME !== "release"
  ) {
    fail("release:publish is restricted to a GitHub release workflow");
  }
  requireTrustedPublishingNpm();
  const manifestPath = resolve(
    options.manifest ?? ".release/package-manifest.json",
  );
  const manifest = await verifyPreparedManifest(manifestPath);
  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  const expectedReleaseCommit =
    options.expectedReleaseCommit ?? process.env.RELEASE_COMMIT;
  if (releaseTag !== manifest.releaseTag) {
    fail("prepared manifest must match the release tag");
  }
  if (
    expectedReleaseCommit === undefined ||
    !/^[0-9a-f]{40,64}$/u.test(expectedReleaseCommit) ||
    !safeEqual(manifest.gitCommit, expectedReleaseCommit)
  ) {
    fail("prepared package manifest must match the release event commit");
  }
  for (const record of manifest.packages.filter(({ publish }) => publish)) {
    const registryIntegrity = queryRegistryIntegrity(
      record.name,
      record.version,
    );
    const decision = decidePublication(record.integrity, registryIntegrity);
    if (decision === "skip") {
      process.stdout.write(
        `Verified existing ${record.name}@${record.version}; skipping.\n`,
      );
      continue;
    }
    const tarball = resolve(dirname(manifestPath), record.tarball);
    runNpm(["publish", tarball, "--access", "public", "--provenance"], {
      cwd: dirname(manifestPath),
    });
    confirmRegistryIntegrity(record);
  }
}

export function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--require-main-ancestor") {
      options.requireMainAncestor = true;
      continue;
    }
    if (argument === "--require-clean") {
      options.requireClean = true;
      continue;
    }
    if (argument === "--require-release-tag") {
      options.requireReleaseTag = true;
      continue;
    }
    const key =
      argument === "--root"
        ? "root"
        : argument === "--output"
          ? "output"
          : argument === "--manifest"
            ? "manifest"
            : argument === "--expected-release-commit"
              ? "expectedReleaseCommit"
              : null;
    if (key === null || arguments_[index + 1] === undefined) {
      fail(`unknown or incomplete argument: ${argument}`);
    }
    options[key] = arguments_[index + 1];
    index += 1;
  }
  return options;
}

function defaultRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const options = parseArguments(arguments_);
  if (command === "check") {
    await validateRepository(options);
    process.stdout.write("Release metadata is valid.\n");
    return;
  }
  if (command === "pack") {
    const { manifestPath } = await prepareRelease(options);
    process.stdout.write(`Prepared release packages at ${manifestPath}.\n`);
    return;
  }
  if (command === "publish") {
    await publishPreparedRelease(options);
    return;
  }
  fail("usage: release-packages.mjs <check|pack|publish> [options]");
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
