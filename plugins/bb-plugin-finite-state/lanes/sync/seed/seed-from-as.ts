import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { AssuranceStudioClient } from "../../../lib/remote/types.js";
import { RemoteError } from "../../../lib/remote/types.js";
import { ENTITIES, parseKey } from "../../../lib/sync/registry.js";
import type { EntityAdapter, ServerEntity } from "../engine/adapter.js";

const CONTRACT_ROOTS = [".fs", "product-security"] as const;
const SEED_KINDS = ["component", "zone", "asset", "dataflow"] as const;

type SeedKind = (typeof SEED_KINDS)[number];

export interface SeedSkippedClass {
  readonly kind: "attackPath" | "mitigation" | "requirement" | "threat";
  readonly reason: string;
}

export const SEED_FROM_AS_SKIPPED_CLASSES: readonly SeedSkippedClass[] = [
  {
    kind: "requirement",
    reason:
      "deferred: follow-up FS-241 will enter legacy Assurance Studio requirements into the reviewed EARS-conversion queue; they are not auto-minted as fs-requirement/v1 documents",
  },
  {
    kind: "mitigation",
    reason: "deferred: no registered production read adapter",
  },
  {
    kind: "attackPath",
    reason: "deferred: no registered production read adapter",
  },
  {
    kind: "threat",
    reason:
      "deferred: Assurance Studio has no threat severity, the authored schema requires severity, and a provenance-preserving severity rule needs owner ratification in FS-243",
  },
] as const;

export interface SeedFromAsResult {
  readonly projectId: string;
  readonly filesWritten: readonly string[];
  readonly skippedHumanEdited: readonly string[];
  readonly skippedClasses: readonly SeedSkippedClass[];
  readonly outcome: "written" | "refused-nonempty" | "as-unconfigured";
  readonly guidance: string | null;
}

export interface SeedFromAsInput {
  readonly assuranceStudio: AssuranceStudioClient;
  readonly assuranceStudioProjectId: string;
  readonly worktreeRoot: string;
  readonly confirmOverwriteNonempty: boolean;
  readonly adapters: readonly EntityAdapter[];
  readonly now?: () => Date;
  readonly createRunId?: () => string;
}

interface PlannedFile {
  readonly file: string;
  readonly content: string;
  readonly humanEdited: boolean;
}

interface StagedFile extends PlannedFile {
  readonly absolute: string;
  readonly backup: string;
  readonly existed: boolean;
  readonly temporary: string;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function hasContractContent(worktreeRoot: string): Promise<boolean> {
  async function hasContent(path: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) return true;
      if (await hasContent(join(path, entry.name))) return true;
    }
    return false;
  }

  for (const root of CONTRACT_ROOTS) {
    if (await hasContent(join(worktreeRoot, root))) return true;
  }
  return false;
}

function seedAdapterMap(
  adapters: readonly EntityAdapter[],
): Map<SeedKind, EntityAdapter> {
  const selected = new Map<SeedKind, EntityAdapter>();
  for (const kind of SEED_KINDS) {
    const matches = adapters.filter((adapter) => adapter.kind === kind);
    if (matches.length !== 1) {
      throw new Error(
        `SEED_ADAPTER_UNAVAILABLE: expected one registered ${kind} read adapter, found ${matches.length}`,
      );
    }
    const adapter = matches[0]!;
    const registry = ENTITIES[kind];
    if (
      adapter.klass !== "VERSIONED" ||
      registry.class !== "VERSIONED" ||
      registry.server !== "assurance-studio" ||
      adapter.serializer.entityKind !== kind
    ) {
      throw new Error(
        `SEED_ADAPTER_INVALID: ${kind} contradicts the frozen registry`,
      );
    }
    selected.set(kind, adapter);
  }
  return selected;
}

function entitySlug(kind: SeedKind, entity: ServerEntity): string {
  const segments = parseKey(entity.key);
  if (segments.length !== 2 || segments[0] !== "slug" || !segments[1]) {
    throw new Error(
      `SEED_ENTITY_KEY_INVALID: ${kind} did not produce a slug key`,
    );
  }
  return segments[1];
}

function sourceHumanEdited(entity: ServerEntity): boolean {
  return entity.payload["humanEdited"] === true;
}

function provenanceHeader(input: {
  projectId: string;
  seededAt: string;
  runId: string;
}): string {
  return [
    "# finite-state-seed/v1",
    `# source_project: ${JSON.stringify(input.projectId)}`,
    `# seeded_at: ${JSON.stringify(input.seededAt)}`,
    `# run_id: ${JSON.stringify(input.runId)}`,
    "",
  ].join("\n");
}

async function collectSeedFiles(
  adapters: ReadonlyMap<SeedKind, EntityAdapter>,
  projectId: string,
  provenance: string,
): Promise<PlannedFile[]> {
  const planned = new Map<string, PlannedFile>();
  for (const kind of SEED_KINDS) {
    const adapter = adapters.get(kind)!;
    for await (const page of adapter.fetchRemote(
      { projectId, projectVersionId: null },
      () => undefined,
    )) {
      for (const entity of page) {
        const slug = entitySlug(kind, entity);
        const file = `${ENTITIES[kind].dir}/${slug}.yaml`;
        if (planned.has(file)) {
          throw new Error(
            `SEED_ENTITY_COLLISION: multiple ${kind} entities target ${file}`,
          );
        }
        planned.set(file, {
          file,
          content: `${provenance}${adapter.serializer.toYaml(entity.payload, {
            idToSlug: () => null,
            onWarning: () => undefined,
          })}`,
          humanEdited: sourceHumanEdited(entity),
        });
      }
    }
  }
  return [...planned.values()].sort((left, right) =>
    left.file.localeCompare(right.file),
  );
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

async function existingRegularFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`SEED_PATH_UNSAFE: ${path} must be a regular file`);
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function stageFiles(
  worktreeRoot: string,
  files: readonly PlannedFile[],
  runId: string,
): Promise<StagedFile[]> {
  const canonicalRoot = await realpath(worktreeRoot);
  const token = createHash("sha256").update(runId).digest("hex").slice(0, 16);
  const staged: StagedFile[] = [];
  try {
    for (const [index, file] of files.entries()) {
      const absolute = join(canonicalRoot, file.file);
      const parent = dirname(absolute);
      await mkdir(parent, { recursive: true });
      const canonicalParent = await realpath(parent);
      if (!isWithin(canonicalRoot, canonicalParent)) {
        throw new Error(`SEED_PATH_UNSAFE: ${file.file} escapes the worktree`);
      }
      const existed = await existingRegularFile(absolute);
      const temporary = join(parent, `.fs-seed-${token}-${index}.tmp`);
      const backup = join(parent, `.fs-seed-${token}-${index}.bak`);
      await writeFile(temporary, file.content, {
        encoding: "utf8",
        flag: "wx",
      });
      staged.push({ ...file, absolute, backup, existed, temporary });
    }
    return staged;
  } catch (error) {
    await Promise.all(
      staged.map((file) => unlink(file.temporary).catch(() => undefined)),
    );
    throw error;
  }
}

async function publishStaged(files: readonly StagedFile[]): Promise<void> {
  const published: StagedFile[] = [];
  try {
    for (const file of files) {
      if (file.existed) await rename(file.absolute, file.backup);
      try {
        await rename(file.temporary, file.absolute);
      } catch (error) {
        if (file.existed) await rename(file.backup, file.absolute);
        throw error;
      }
      published.push(file);
    }
  } catch (error) {
    for (const file of [...published].reverse()) {
      await unlink(file.absolute).catch(() => undefined);
      if (file.existed) await rename(file.backup, file.absolute);
    }
    await Promise.all(
      files.map((file) => unlink(file.temporary).catch(() => undefined)),
    );
    throw error;
  }
  await Promise.all(
    files.filter((file) => file.existed).map((file) => unlink(file.backup)),
  );
}

function result(
  projectId: string,
  outcome: SeedFromAsResult["outcome"],
  input: {
    filesWritten?: readonly string[];
    skippedHumanEdited?: readonly string[];
    guidance?: string | null;
  } = {},
): SeedFromAsResult {
  return {
    projectId,
    filesWritten: input.filesWritten ?? [],
    skippedHumanEdited: input.skippedHumanEdited ?? [],
    skippedClasses: SEED_FROM_AS_SKIPPED_CLASSES,
    outcome,
    guidance: input.guidance ?? null,
  };
}

/** Imports the adapter-backed AS baseline into tracked YAML and performs no other mutation. */
export async function seedFromAs(
  input: SeedFromAsInput,
): Promise<SeedFromAsResult> {
  try {
    await input.assuranceStudio.health();
  } catch (error) {
    if (
      error instanceof RemoteError &&
      error.service === "assurance-studio" &&
      error.code === "REMOTE_UNAVAILABLE"
    ) {
      return result(input.assuranceStudioProjectId, "as-unconfigured", {
        guidance:
          "Configure Assurance Studio URL (asBaseUrl) and API key (asApiKey), reload the plugin, then rerun seed --from as.",
      });
    }
    throw error;
  }

  const nonempty = await hasContractContent(input.worktreeRoot);
  if (nonempty && !input.confirmOverwriteNonempty) {
    return result(input.assuranceStudioProjectId, "refused-nonempty", {
      guidance:
        "The tracked contract roots are non-empty. Review them, then rerun with --confirm-overwrite-nonempty to replace only non-human-edited seeded entities.",
    });
  }

  const runId = (input.createRunId ?? randomUUID)();
  const seededAt = (input.now ?? (() => new Date()))().toISOString();
  const adapters = seedAdapterMap(input.adapters);
  const planned = await collectSeedFiles(
    adapters,
    input.assuranceStudioProjectId,
    provenanceHeader({
      projectId: input.assuranceStudioProjectId,
      seededAt,
      runId,
    }),
  );
  const writable: PlannedFile[] = [];
  const skippedHumanEdited: string[] = [];
  for (const file of planned) {
    const exists = await existingRegularFile(
      join(input.worktreeRoot, file.file),
    );
    if (nonempty && exists && file.humanEdited) {
      skippedHumanEdited.push(file.file);
    } else {
      writable.push(file);
    }
  }

  const staged = await stageFiles(input.worktreeRoot, writable, runId);
  await publishStaged(staged);
  return result(input.assuranceStudioProjectId, "written", {
    filesWritten: writable.map((file) => file.file),
    skippedHumanEdited,
  });
}
