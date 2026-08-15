import { randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { Store } from "../store/index.js";
import { ENTITIES, type EntityKind } from "../sync/registry.js";
import { applyOverlayIndex } from "../../lanes/findings/overlay/indexer.js";
import { readOverlayFiles } from "../../lanes/findings/overlay/reader.js";
import { parseCanvasEntity } from "../../lanes/product-security/canvas/editing/writer.js";
import { architectureEntityPayload } from "../../lanes/product-security/canvas/editing/schema.js";
import { canonicalRequirement } from "../../lanes/product-security/requirements/cards/adapter.js";
import { requirementSemanticSha256 } from "../../lanes/product-security/requirements/cards/adapter.js";
import type {
  RequirementYamlV1,
  VerificationContract,
} from "../../lanes/product-security/requirements/cards/schema.js";
import { validateRequirementYaml } from "../../lanes/product-security/requirements/cards/validator.js";
import { canonicalJson } from "../../lanes/sync/serialize/canonical.js";
import { createSerializer } from "../../lanes/sync/serialize/serializer.js";
import { parseYaml, SerializeError } from "../../lanes/sync/serialize/yaml.js";
import { BaseSnapshotStore } from "../../lanes/sync/store/base-snapshot.js";
import {
  computeProjectionKey,
  CONTRACT_ROOTS,
  REPO_LOCAL_PROJECT_ID_PREFIX,
  repoContractIdentity,
  type ProjectionKey,
} from "./projection-key.js";

const SIDECAR_VERSION = 1 as const;
const SIDECAR_PREFIX = "contract-load-";
const SIDECAR_PATTERN = /^contract-load-([0-9a-f]{64})\.json$/u;
const SYNTHETIC_VERSION_PREFIX = "fs-local-checkout:";

type ProjectedKind =
  | "asset"
  | "attackPath"
  | "checkParams"
  | "component"
  | "dataflow"
  | "mitigation"
  | "requirement"
  | "threat"
  | "zone";

const PROJECTED_KINDS: readonly ProjectedKind[] = [
  "asset",
  "attackPath",
  "checkParams",
  "component",
  "dataflow",
  "mitigation",
  "requirement",
  "threat",
  "zone",
];

export interface ContractLoadScope {
  readonly projectId: string;
  readonly projectVersionId: string;
}

export interface ContractLoadDiagnostic {
  readonly path: string;
  readonly message: string;
}

export interface ContractLoadResult {
  readonly key: ProjectionKey;
  readonly rebuilt: boolean;
  readonly entityCounts: Readonly<Record<string, number>>;
  readonly diagnostics: readonly ContractLoadDiagnostic[];
}

interface ProjectionEntity {
  readonly file: string;
  readonly kind: ProjectedKind;
  readonly key: string;
  readonly payload: Record<string, unknown>;
  readonly requirement: RequirementYamlV1 | null;
}

interface SidecarProjection {
  readonly version: typeof SIDECAR_VERSION;
  readonly canonicalPath: string;
  readonly repositoryDigest: string;
  readonly scope: ContractLoadScope;
  readonly key: ProjectionKey;
  readonly entityCounts: Readonly<Record<string, number>>;
  readonly diagnostics: readonly ContractLoadDiagnostic[];
  readonly overlayProjects: readonly string[];
}

interface CountRow {
  count: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function diagnosticMessage(error: unknown): string {
  if (error instanceof SerializeError && error.line !== null) {
    return `line ${error.line}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function normalizedPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function sidecarFile(store: Store, repositoryDigest: string): string {
  if (store.db.name === ":memory:") {
    throw new Error(
      "Repo contract projection requires a file-backed SQLite store",
    );
  }
  return join(
    dirname(store.db.name),
    `${SIDECAR_PREFIX}${repositoryDigest}.json`,
  );
}

function projectionScope(repositoryDigest: string): ContractLoadScope {
  return {
    projectId: `${REPO_LOCAL_PROJECT_ID_PREFIX}${repositoryDigest}`,
    projectVersionId: `${SYNTHETIC_VERSION_PREFIX}${repositoryDigest}`,
  };
}

function exactProjectionScope(
  scope: ContractLoadScope,
  repositoryDigest: string,
): boolean {
  const expected = projectionScope(repositoryDigest);
  return (
    scope.projectId === expected.projectId &&
    scope.projectVersionId === expected.projectVersionId
  );
}

function projectionKey(value: unknown): ProjectionKey | null {
  if (
    !isRecord(value) ||
    typeof value["headCommit"] !== "string" ||
    typeof value["contentHash"] !== "string"
  ) {
    return null;
  }
  if (
    !/^[0-9a-f]{40,64}$/u.test(value["headCommit"]) ||
    !/^[0-9a-f]{64}$/u.test(value["contentHash"])
  ) {
    return null;
  }
  return {
    headCommit: value["headCommit"],
    contentHash: value["contentHash"],
  };
}

function projectionCounts(
  value: unknown,
): Readonly<Record<string, number>> | null {
  if (!isRecord(value)) return null;
  const counts: Record<string, number> = {};
  for (const [kind, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      return null;
    }
    counts[kind] = count;
  }
  return counts;
}

function projectionDiagnostics(
  value: unknown,
): readonly ContractLoadDiagnostic[] | null {
  if (!Array.isArray(value)) return null;
  const diagnostics: ContractLoadDiagnostic[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item["path"] !== "string" ||
      typeof item["message"] !== "string"
    ) {
      return null;
    }
    diagnostics.push({ path: item["path"], message: item["message"] });
  }
  return diagnostics;
}

function projectionOverlayProjects(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return [...new Set(value)].sort((left, right) => left.localeCompare(right));
}

function sidecarProjection(value: unknown): SidecarProjection | null {
  if (
    !isRecord(value) ||
    value["version"] !== SIDECAR_VERSION ||
    typeof value["canonicalPath"] !== "string" ||
    typeof value["repositoryDigest"] !== "string" ||
    !isRecord(value["scope"]) ||
    typeof value["scope"]["projectId"] !== "string" ||
    typeof value["scope"]["projectVersionId"] !== "string"
  ) {
    return null;
  }
  const key = projectionKey(value["key"]);
  const entityCounts = projectionCounts(value["entityCounts"]);
  const diagnostics = projectionDiagnostics(value["diagnostics"]);
  const overlayProjects = projectionOverlayProjects(value["overlayProjects"]);
  if (
    key === null ||
    entityCounts === null ||
    diagnostics === null ||
    overlayProjects === null
  )
    return null;
  return {
    version: SIDECAR_VERSION,
    canonicalPath: value["canonicalPath"],
    repositoryDigest: value["repositoryDigest"],
    scope: {
      projectId: value["scope"]["projectId"],
      projectVersionId: value["scope"]["projectVersionId"],
    },
    key,
    entityCounts,
    diagnostics,
    overlayProjects,
  };
}

async function readSidecar(path: string): Promise<SidecarProjection | null> {
  try {
    return sidecarProjection(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function atomicWriteSidecar(
  path: string,
  sidecar: SidecarProjection,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(sidecar, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch((unlinkError: unknown) => {
      if (!isMissing(unlinkError)) throw unlinkError;
    });
    throw error;
  }
}

function hasProjectionRows(
  store: Store,
  scope: ContractLoadScope,
  overlayProjects: readonly string[],
): boolean {
  const row = store.db
    .prepare<[string, string, string, string], CountRow>(
      `SELECT (
         (SELECT COUNT(*)
            FROM base_snapshot base
            JOIN sync_state state
              ON state.project_id = base.project_id
             AND state.project_version_id = base.project_version_id
             AND state.entity_kind = base.entity_kind
             AND state.accepted_generation_id = base.generation_id
           WHERE base.project_id = ? AND base.project_version_id = ?)
         + (SELECT COUNT(*)
              FROM verification_checks checks
              JOIN pull_generation generation
                ON generation.project_id = checks.project_id
               AND generation.project_version_id = checks.project_version_id
               AND generation.generation_id = checks.generation_id
               AND generation.status = 'accepted'
             WHERE checks.project_id = ? AND checks.project_version_id = ?)
       ) AS count`,
    )
    .get(
      scope.projectId,
      scope.projectVersionId,
      scope.projectId,
      scope.projectVersionId,
    );
  if ((row?.count ?? 0) > 0) return true;
  const overlayExists = store.db.prepare<[string], { present: number }>(
    `SELECT 1 AS present
       FROM overlay_index
      WHERE project_id = ?
      LIMIT 1`,
  );
  return overlayProjects.some(
    (projectId) => overlayExists.get(projectId) !== undefined,
  );
}

function pruneProjection(store: Store, scope: ContractLoadScope): void {
  store.tx(() => {
    const pushRows =
      store.db
        .prepare<[string, string], CountRow>(
          `SELECT COUNT(*) AS count
           FROM push_log
          WHERE project_id = ? AND project_version_id = ?`,
        )
        .get(scope.projectId, scope.projectVersionId)?.count ?? 0;
    if (pushRows > 0) {
      throw new Error(
        `Refusing to prune synthetic projection ${scope.projectId}: it has push-log rows`,
      );
    }
    store.db
      .prepare(
        `DELETE FROM workspace_platform_project_binding
          WHERE platform_project_id = ?`,
      )
      .run(scope.projectId);
    store.db
      .prepare(
        `DELETE FROM sync_state
          WHERE project_id = ? AND project_version_id = ?`,
      )
      .run(scope.projectId, scope.projectVersionId);
    store.db
      .prepare(
        `DELETE FROM pull_generation
          WHERE project_id = ? AND project_version_id = ?`,
      )
      .run(scope.projectId, scope.projectVersionId);
  });
}

async function pathMatchesDigest(
  path: string,
  digest: string,
): Promise<boolean> {
  try {
    return (
      (await repoContractIdentity(await realpath(path))).repositoryDigest ===
      digest
    );
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function pruneStaleSidecars(store: Store): Promise<void> {
  const directory = dirname(sidecarFile(store, "0".repeat(64)));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const sidecars: Array<{
    digest: string;
    path: string;
    sidecar: SidecarProjection | null;
    stale: boolean;
  }> = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile()) continue;
    const matched = SIDECAR_PATTERN.exec(entry.name);
    if (matched === null) continue;
    const digest = matched[1];
    if (digest === undefined) continue;
    const path = join(directory, entry.name);
    const sidecar = await readSidecar(path);
    const stale =
      sidecar === null ||
      sidecar.repositoryDigest !== digest ||
      !exactProjectionScope(sidecar.scope, digest) ||
      !(await pathMatchesDigest(sidecar.canonicalPath, digest));
    sidecars.push({ digest, path, sidecar, stale });
  }
  const validOverlayProjects = new Set(
    sidecars
      .filter((item) => !item.stale)
      .flatMap((item) => item.sidecar?.overlayProjects ?? []),
  );
  for (const item of sidecars.filter((candidate) => candidate.stale)) {
    pruneProjection(store, projectionScope(item.digest));
    for (const projectId of item.sidecar?.overlayProjects ?? []) {
      if (validOverlayProjects.has(projectId)) continue;
      store.db
        .prepare("DELETE FROM overlay_index WHERE project_id = ?")
        .run(projectId);
    }
    await unlink(item.path).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function yamlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(path: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        /\.ya?ml$/iu.test(entry.name)
      ) {
        files.push(child);
      }
    }
  }
  for (const contractRoot of CONTRACT_ROOTS) {
    await walk(join(root, contractRoot));
  }
  return files;
}

function projectedKind(path: string): ProjectedKind | null {
  const directory = path.slice(0, path.lastIndexOf("/"));
  if (
    directory === "product-security/architecture/components" ||
    directory === ".fs/architecture/components"
  )
    return "component";
  if (
    directory === "product-security/architecture/zones" ||
    directory === ".fs/architecture/zones"
  )
    return "zone";
  if (
    directory === "product-security/architecture/dataflows" ||
    directory === ".fs/architecture/dataflows"
  )
    return "dataflow";
  if (
    directory === "product-security/architecture/assets" ||
    directory === ".fs/architecture/assets"
  )
    return "asset";
  if (directory === "product-security/threats" || directory === ".fs/threats") {
    return "threat";
  }
  if (
    directory === "product-security/mitigations" ||
    directory === ".fs/mitigations"
  )
    return "mitigation";
  if (
    directory === "product-security/requirements" ||
    directory === ".fs/requirements"
  )
    return "requirement";
  if (directory === ".fs/verification/checks") return "checkParams";
  if (directory === ".fs/attack-paths") return "attackPath";
  return null;
}

function entityKey(
  kind: Exclude<ProjectedKind, "requirement">,
  payload: Readonly<Record<string, unknown>>,
): string {
  switch (kind) {
    case "asset":
      return ENTITIES.asset.key(payload);
    case "attackPath":
      return ENTITIES.attackPath.key(payload);
    case "checkParams":
      return ENTITIES.checkParams.key(payload);
    case "component":
      return ENTITIES.component.key(payload);
    case "dataflow":
      return ENTITIES.dataflow.key(payload);
    case "mitigation":
      return ENTITIES.mitigation.key(payload);
    case "threat":
      return ENTITIES.threat.key(payload);
    case "zone":
      return ENTITIES.zone.key(payload);
  }
}

function requirementRecord(
  requirement: RequirementYamlV1,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(requirement));
}

async function parseProjection(root: string): Promise<{
  entities: ProjectionEntity[];
  diagnostics: ContractLoadDiagnostic[];
}> {
  const entities: ProjectionEntity[] = [];
  const diagnostics: ContractLoadDiagnostic[] = [];
  const acceptedKeys = new Map<string, string>();
  for (const absoluteFile of await yamlFiles(root)) {
    const file = normalizedPath(root, absoluteFile);
    if (file.startsWith(".fs/triage/")) continue;
    try {
      const metadata = await lstat(absoluteFile);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new SerializeError(
          file,
          null,
          "YAML path must be a regular file, not a symlink",
        );
      }
      const text = await readFile(absoluteFile, "utf8");
      const kind = projectedKind(file);
      if (kind === null) {
        parseYaml(text, file);
        continue;
      }
      let entity: ProjectionEntity;
      if (kind === "requirement") {
        const validated = validateRequirementYaml(text, file);
        if (!validated.success) {
          const first = validated.errors[0];
          throw new SerializeError(
            file,
            first?.line ?? null,
            first === undefined
              ? "Requirement YAML is invalid"
              : `${first.code}: ${first.message}`,
          );
        }
        const requirement = canonicalRequirement(validated.data);
        const expectedFile = `${file.slice(0, file.lastIndexOf("/"))}/${requirement.id}.yaml`;
        if (file !== expectedFile) {
          throw new SerializeError(
            file,
            1,
            `Requirement ${requirement.id} must use canonical path ${expectedFile}`,
          );
        }
        entity = {
          file,
          kind,
          key: ENTITIES.requirement.key({ reqId: requirement.id }),
          payload: requirementRecord(requirement),
          requirement,
        };
      } else {
        const payload =
          kind === "asset" ||
          kind === "component" ||
          kind === "dataflow" ||
          kind === "threat" ||
          kind === "zone"
            ? architectureEntityPayload(parseCanvasEntity(kind, text, file))
            : createSerializer(kind).fromYaml(text, file);
        entity = {
          file,
          kind,
          key: entityKey(kind, payload),
          payload,
          requirement: null,
        };
      }
      const scopedKey = `${entity.kind}\0${entity.key}`;
      const prior = acceptedKeys.get(scopedKey);
      if (prior !== undefined) {
        diagnostics.push({
          path: file,
          message: `${entity.kind} key is already authored in ${prior}`,
        });
        continue;
      }
      acceptedKeys.set(scopedKey, file);
      entities.push(entity);
    } catch (error) {
      diagnostics.push({ path: file, message: diagnosticMessage(error) });
    }
  }
  return { entities, diagnostics };
}

function groupedEntities(
  entities: readonly ProjectionEntity[],
): ReadonlyMap<ProjectedKind, readonly ProjectionEntity[]> {
  const grouped = new Map<ProjectedKind, ProjectionEntity[]>();
  for (const kind of PROJECTED_KINDS) grouped.set(kind, []);
  for (const entity of entities) grouped.get(entity.kind)?.push(entity);
  return grouped;
}

function entityCounts(
  entities: readonly ProjectionEntity[],
  triageCount: number,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const kind of PROJECTED_KINDS) counts[kind] = 0;
  for (const entity of entities)
    counts[entity.kind] = (counts[entity.kind] ?? 0) + 1;
  counts["triage"] = triageCount;
  return counts;
}

function stringValue(
  payload: Readonly<Record<string, unknown>>,
  ...fields: readonly string[]
): string | null {
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function numberValue(
  payload: Readonly<Record<string, unknown>>,
  ...fields: readonly string[]
): number | null {
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function jsonValue(value: unknown): string | null {
  return value === undefined || value === null ? null : canonicalJson(value);
}

function checkRaw(
  requirement: RequirementYamlV1,
  contract: VerificationContract,
  file: string,
): string {
  return canonicalJson({
    requirementId: requirement.id,
    contract,
    source: file,
  });
}

interface ProjectedCheckDefinition {
  readonly authoritative: boolean;
  readonly signature: string;
}

function requirementCheckSignature(contract: VerificationContract): string {
  return canonicalJson({
    method: contract.method,
    tier: contract.tier,
    passCriteria: contract.pass_criteria,
    failCriteria: contract.fail_criteria ?? null,
    expectedEvidence: contract.expected_evidence ?? [],
  });
}

function checkParamsSignature(
  payload: Readonly<Record<string, unknown>>,
): string {
  return canonicalJson({
    method:
      stringValue(payload, "check_type", "checkType", "method") ?? "manual",
    tier: stringValue(payload, "category", "tier"),
    passCriteria: stringValue(payload, "pass_criteria", "passCriteria"),
    failCriteria: stringValue(payload, "fail_criteria", "failCriteria"),
    expectedEvidence:
      payload["expected_evidence"] ?? payload["expectedEvidence"] ?? [],
  });
}

function insertVerificationProjection(
  store: Store,
  scope: ContractLoadScope,
  generationId: string,
  entities: readonly ProjectionEntity[],
  pulledAt: string,
): ContractLoadDiagnostic[] {
  const diagnostics: ContractLoadDiagnostic[] = [];
  const definitions = new Map<string, ProjectedCheckDefinition>();
  const insertCheck = store.db.prepare(
    `INSERT INTO verification_checks
       (project_id, project_version_id, generation_id, check_id, code, name,
        check_type, category, description, pass_criteria, fail_criteria,
        input_description, parameters, default_sla_days, deleted_at,
        review_status, review_version, raw, pulled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '0', ?, ?)`,
  );
  const insertMapping = store.db.prepare(
    `INSERT INTO requirement_check_mappings
       (project_id, project_version_id, generation_id, requirement_key,
        check_id, is_required, coverage_level, suppressed, raw, pulled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRollup = store.db.prepare(
    `INSERT INTO requirement_rollup
       (project_id, project_version_id, generation_id, requirement_key,
        verification_status, total_checks, verified_checks, failed_checks,
        error_checks, inconclusive_checks, running_checks, pending_checks,
        skipped_checks, last_run_at, pulled_at)
     VALUES (?, ?, ?, ?, NULL, ?, 0, 0, 0, 0, 0, 0, 0, NULL, ?)`,
  );

  for (const entity of entities.filter(
    (candidate) => candidate.kind === "checkParams",
  )) {
    const code = stringValue(entity.payload, "code");
    if (code === null) continue;
    const raw = canonicalJson({ source: entity.file, payload: entity.payload });
    definitions.set(code, {
      authoritative: true,
      signature: checkParamsSignature(entity.payload),
    });
    insertCheck.run(
      scope.projectId,
      scope.projectVersionId,
      generationId,
      code,
      code,
      stringValue(entity.payload, "name", "title") ?? code,
      stringValue(entity.payload, "check_type", "checkType", "method") ??
        "manual",
      stringValue(entity.payload, "category", "tier"),
      stringValue(entity.payload, "description"),
      stringValue(entity.payload, "pass_criteria", "passCriteria"),
      stringValue(entity.payload, "fail_criteria", "failCriteria"),
      stringValue(entity.payload, "input_description", "inputDescription"),
      jsonValue(entity.payload["parameters"]),
      numberValue(entity.payload, "default_sla_days", "defaultSlaDays"),
      raw,
      pulledAt,
    );
  }

  for (const entity of entities.filter(
    (candidate) => candidate.requirement !== null,
  )) {
    const requirement = entity.requirement;
    if (requirement === null) continue;
    let totalChecks = 0;
    for (const contract of requirement.verification) {
      if (contract.check === null) continue;
      const raw = checkRaw(requirement, contract, entity.file);
      const signature = requirementCheckSignature(contract);
      const prior = definitions.get(contract.check);
      if (prior === undefined) {
        definitions.set(contract.check, { authoritative: false, signature });
        insertCheck.run(
          scope.projectId,
          scope.projectVersionId,
          generationId,
          contract.check,
          contract.check,
          contract.check,
          contract.method,
          contract.tier,
          null,
          contract.pass_criteria,
          contract.fail_criteria ?? null,
          null,
          jsonValue({
            expectedEvidence: contract.expected_evidence ?? [],
            tier: contract.tier,
          }),
          null,
          raw,
          pulledAt,
        );
      } else if (!prior.authoritative && prior.signature !== signature) {
        diagnostics.push({
          path: entity.file,
          message: `check ${contract.check} has conflicting requirement definitions`,
        });
        continue;
      }
      insertMapping.run(
        scope.projectId,
        scope.projectVersionId,
        generationId,
        entity.key,
        contract.check,
        contract.required ? 1 : 0,
        contract.coverage ?? null,
        contract.suppressed === true ? 1 : 0,
        raw,
        pulledAt,
      );
      if (contract.suppressed !== true) totalChecks += 1;
    }
    insertRollup.run(
      scope.projectId,
      scope.projectVersionId,
      generationId,
      entity.key,
      totalChecks,
      pulledAt,
    );
  }
  return diagnostics;
}

function insertAttackPaths(
  store: Store,
  scope: ContractLoadScope,
  generationId: string,
  entities: readonly ProjectionEntity[],
  pulledAt: string,
): void {
  const insert = store.db.prepare(
    `INSERT INTO attack_paths
       (project_id, project_version_id, generation_id, path_id,
        route_signature, name, threat_key, steps, edges, total_steps,
        zones_traversed, exploitability, review_status, review_version,
        raw, pulled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', ?, ?)`,
  );
  for (const entity of entities.filter(
    (candidate) => candidate.kind === "attackPath",
  )) {
    const routeSignature = stringValue(
      entity.payload,
      "routeSignature",
      "route_signature",
    );
    if (routeSignature === null) continue;
    const steps = entity.payload["steps"] ?? [];
    insert.run(
      scope.projectId,
      scope.projectVersionId,
      generationId,
      stringValue(entity.payload, "pathId", "path_id", "id") ?? entity.key,
      routeSignature,
      stringValue(entity.payload, "name"),
      stringValue(entity.payload, "threatKey", "threat_key"),
      canonicalJson(steps),
      jsonValue(entity.payload["edges"]),
      Array.isArray(steps)
        ? steps.length
        : numberValue(entity.payload, "totalSteps", "total_steps"),
      jsonValue(
        entity.payload["zonesTraversed"] ?? entity.payload["zones_traversed"],
      ),
      stringValue(entity.payload, "exploitability"),
      stringValue(entity.payload, "reviewStatus", "review_status"),
      canonicalJson({ source: entity.file, payload: entity.payload }),
      pulledAt,
    );
  }
}

function publishProjection(
  store: Store,
  scope: ContractLoadScope,
  entities: readonly ProjectionEntity[],
): ContractLoadDiagnostic[] {
  const grouped = groupedEntities(entities);
  const generationId = `contract-load-${randomUUID()}`;
  const pulledAt = new Date().toISOString();
  const generationKinds: readonly EntityKind[] = PROJECTED_KINDS;
  return store.tx(() => {
    store.db
      .prepare(
        `UPDATE pull_generation
            SET status = 'cancelled', completed_at = ?, error = ?
          WHERE project_id = ? AND project_version_id = ? AND status = 'staging'`,
      )
      .run(
        pulledAt,
        "Superseded by repository contract reload",
        scope.projectId,
        scope.projectVersionId,
      );
    store.db
      .prepare(
        `INSERT INTO pull_generation
           (project_id, project_version_id, generation_id, status,
            requested_kinds_json, started_at)
         VALUES (?, ?, ?, 'staging', ?, ?)`,
      )
      .run(
        scope.projectId,
        scope.projectVersionId,
        generationId,
        canonicalJson([...generationKinds]),
        pulledAt,
      );
    const stageState = store.db.prepare(
      `INSERT INTO sync_state
         (project_id, project_version_id, entity_kind,
          accepted_generation_id, staging_generation_id, base_revision,
          staging_continuation, staged_pages, staged_rows,
          staged_quarantined, error)
       VALUES (?, ?, ?, NULL, ?, 0, NULL, 1, ?, 0, NULL)
       ON CONFLICT (project_id, project_version_id, entity_kind) DO UPDATE SET
         staging_generation_id = excluded.staging_generation_id,
         staging_continuation = NULL,
         staged_pages = 1,
         staged_rows = excluded.staged_rows,
         staged_quarantined = 0,
         error = NULL`,
    );
    for (const kind of PROJECTED_KINDS) {
      const rows = grouped.get(kind) ?? [];
      stageState.run(
        scope.projectId,
        scope.projectVersionId,
        kind,
        generationId,
        rows.length,
      );
    }

    const baseStore = new BaseSnapshotStore(store.db);
    for (const kind of PROJECTED_KINDS) {
      const rows = grouped.get(kind) ?? [];
      if (kind === "requirement") {
        const insert = store.db.prepare(
          `INSERT INTO base_snapshot
             (project_id, project_version_id, entity_kind, generation_id,
              entity_key, remote_id, payload, content_hash, pulled_at)
           VALUES (?, ?, 'requirement', ?, ?, NULL, ?, ?, ?)`,
        );
        for (const entity of rows) {
          const requirement = entity.requirement;
          if (requirement === null) continue;
          insert.run(
            scope.projectId,
            scope.projectVersionId,
            generationId,
            entity.key,
            canonicalJson(entity.payload),
            requirementSemanticSha256(requirement),
            pulledAt,
          );
        }
      } else {
        baseStore.putStagingPage(
          scope.projectId,
          scope.projectVersionId,
          kind,
          generationId,
          rows.map((entity) => ({
            projectId: scope.projectId,
            projectVersionId: scope.projectVersionId,
            entityKind: kind,
            generationId,
            entityKey: entity.key,
            remoteId: null,
            payload: entity.payload,
            contentHash: "",
            pulledAt,
          })),
        );
      }
    }

    const diagnostics = insertVerificationProjection(
      store,
      scope,
      generationId,
      entities,
      pulledAt,
    );
    insertAttackPaths(store, scope, generationId, entities, pulledAt);

    const publishState = store.db.prepare(
      `UPDATE sync_state
          SET accepted_generation_id = ?, staging_generation_id = NULL,
              base_revision = base_revision + 1,
              staging_continuation = NULL, staged_pages = 0,
              staged_rows = 0, staged_quarantined = 0,
              last_pull = ?, error = NULL
        WHERE project_id = ? AND project_version_id = ?
          AND entity_kind = ? AND staging_generation_id = ?`,
    );
    for (const kind of PROJECTED_KINDS) {
      const result = publishState.run(
        generationId,
        pulledAt,
        scope.projectId,
        scope.projectVersionId,
        kind,
        generationId,
      );
      if (result.changes !== 1) {
        throw new Error(`Repository projection lost the ${kind} staging fence`);
      }
    }
    store.db
      .prepare(
        `UPDATE pull_generation
            SET status = 'superseded'
          WHERE project_id = ? AND project_version_id = ?
            AND status = 'accepted' AND generation_id <> ?`,
      )
      .run(scope.projectId, scope.projectVersionId, generationId);
    store.db
      .prepare(
        `UPDATE pull_generation
            SET status = 'accepted', completed_at = ?, accepted_at = ?
          WHERE project_id = ? AND project_version_id = ?
            AND generation_id = ? AND status = 'staging'`,
      )
      .run(
        pulledAt,
        pulledAt,
        scope.projectId,
        scope.projectVersionId,
        generationId,
      );
    return diagnostics;
  });
}

function keysEqual(left: ProjectionKey, right: ProjectionKey): boolean {
  return (
    left.headCommit === right.headCommit &&
    left.contentHash === right.contentHash
  );
}

async function refreshOverlayProjection(
  store: Store,
  root: string,
  priorProjects: readonly string[],
): Promise<{
  readonly indexed: number;
  readonly errors: readonly ContractLoadDiagnostic[];
  readonly projects: readonly string[];
}> {
  // Await all filesystem work before any overlay_index mutation. An await
  // between preserve-copy and restore yields the event loop so a concurrent
  // triage write can interleave with the periodic background rebuild.
  const discovered = await readOverlayFiles(root);
  const projects = [...new Set(discovered.projects)].sort((left, right) =>
    left.localeCompare(right),
  );
  const ownedProjects = [...new Set([...priorProjects, ...projects])];
  const temporaryTable = `contract_load_preserved_overlay_${randomUUID().replaceAll("-", "")}`;
  try {
    return store.tx(() => {
      store.db.exec(
        `CREATE TEMP TABLE ${temporaryTable} AS SELECT * FROM overlay_index WHERE 0`,
      );
      if (ownedProjects.length === 0) {
        store.db.exec(
          `INSERT INTO ${temporaryTable} SELECT * FROM overlay_index`,
        );
      } else {
        const placeholders = ownedProjects.map(() => "?").join(", ");
        store.db
          .prepare(
            `INSERT INTO ${temporaryTable}
             SELECT * FROM overlay_index WHERE project_id NOT IN (${placeholders})`,
          )
          .run(...ownedProjects);
      }
      const report = applyOverlayIndex(store.db, discovered);
      store.db.exec(
        `INSERT INTO overlay_index SELECT * FROM ${temporaryTable}`,
      );
      return {
        indexed: report.indexed,
        projects,
        errors: report.errors.map((error) => ({
          path: error.file,
          message:
            error.line === null
              ? error.message
              : `line ${error.line}: ${error.message}`,
        })),
      };
    });
  } finally {
    store.db.exec(`DROP TABLE IF EXISTS ${temporaryTable}`);
  }
}

export async function loadRepoContract(
  workspaceRoot: string,
  store: Store,
  scope: ContractLoadScope,
): Promise<ContractLoadResult> {
  await pruneStaleSidecars(store);
  const identity = await repoContractIdentity(workspaceRoot);
  if (!exactProjectionScope(scope, identity.repositoryDigest)) {
    throw new Error(
      "Repo contract scope must be the canonical repository-derived scope",
    );
  }
  const key = await computeProjectionKey(identity.canonicalRoot);
  const path = sidecarFile(store, identity.repositoryDigest);
  const prior = await readSidecar(path);
  if (
    prior !== null &&
    prior.canonicalPath === identity.canonicalRoot &&
    prior.repositoryDigest === identity.repositoryDigest &&
    exactProjectionScope(prior.scope, identity.repositoryDigest) &&
    keysEqual(prior.key, key) &&
    hasProjectionRows(store, scope, prior.overlayProjects)
  ) {
    return {
      key,
      rebuilt: false,
      entityCounts: prior.entityCounts,
      diagnostics: prior.diagnostics,
    };
  }

  const parsed = await parseProjection(identity.canonicalRoot);
  const projectionDiagnostics = publishProjection(
    store,
    scope,
    parsed.entities,
  );
  const overlay = await refreshOverlayProjection(
    store,
    identity.canonicalRoot,
    prior?.overlayProjects ?? [],
  );
  const diagnostics = [
    ...parsed.diagnostics,
    ...projectionDiagnostics,
    ...overlay.errors,
  ].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.message.localeCompare(right.message),
  );
  const counts = entityCounts(parsed.entities, overlay.indexed);
  await atomicWriteSidecar(path, {
    version: SIDECAR_VERSION,
    canonicalPath: identity.canonicalRoot,
    repositoryDigest: identity.repositoryDigest,
    scope,
    key,
    entityCounts: counts,
    diagnostics,
    overlayProjects: overlay.projects,
  });
  return { key, rebuilt: true, entityCounts: counts, diagnostics };
}

export function contractLoadScope(repositoryDigest: string): ContractLoadScope {
  if (!/^[0-9a-f]{64}$/u.test(repositoryDigest)) {
    throw new Error("Repository digest must be a lowercase SHA-256 value");
  }
  return projectionScope(repositoryDigest);
}

export function contractLoadSidecarName(repositoryDigest: string): string {
  if (!/^[0-9a-f]{64}$/u.test(repositoryDigest)) {
    throw new Error("Repository digest must be a lowercase SHA-256 value");
  }
  return `${SIDECAR_PREFIX}${repositoryDigest}.json`;
}
