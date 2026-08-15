import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import type { BbPluginApi } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { JsonValue } from "../../../../shared/contract.js";
import {
  cacheStateSchema,
  jsonValueSchema,
} from "../../../../shared/contract.js";
import { toStorageProjectVersionId } from "../../../../lib/store/index.js";
import type { CanvasTaraKind } from "../foundation/types.js";
import { architectureEntityPayload } from "./schema.js";
import {
  canvasDeletedMarkerPrefix,
  createSdkCanvasFileStore,
  type CanvasFileDiagnostic,
  type CanvasProjectSource,
  type StoredCanvasEntity,
} from "./writer.js";

interface TaraSyncRow {
  accepted_generation_id: string | null;
  base_revision: number;
  last_pull: string | null;
  error: string | null;
}

interface TaraSnapshotRow {
  entity_key: string;
  payload: string;
}

interface TaraTotalRow {
  total: number;
}

type TaraKind = CanvasTaraKind | "threat";

const EXCLUDED_TABLE = "fs_tara_list_excluded";

const PAGE_JSON_EACH =
  /AND NOT EXISTS \(\s*SELECT 1 FROM json_each\(\?\) AS excluded\s*WHERE excluded\.value = entity_key\s*\)/u;
const COUNT_JSON_EACH =
  /WHERE NOT EXISTS \(\s*SELECT 1 FROM json_each\(\?\) AS excluded\s*WHERE excluded\.value = entity_key\s*\)/u;

const patchedDatabases = new WeakSet<object>();

/**
 * Materialize working/deleted slug exclusions once into a TEMP table instead of
 * re-parsing json_each(?) per candidate row (FS-142 N2).
 */
export function loadTaraListExclusions(
  db: Database.Database,
  excluded: Iterable<string>,
): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS ${EXCLUDED_TABLE} (
      entity_key TEXT PRIMARY KEY
    ) WITHOUT ROWID;
    DELETE FROM ${EXCLUDED_TABLE};
  `);
  const insertExcluded = db.prepare(
    `INSERT OR IGNORE INTO ${EXCLUDED_TABLE}(entity_key) VALUES (?)`,
  );
  const loadExcluded = db.transaction((slugs: Iterable<string>) => {
    for (const slug of slugs) insertExcluded.run(slug);
  });
  loadExcluded(excluded);
}

function parseExcludedJson(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * Accelerate legacy register.ts taraList exclusion SQL (json_each(?)) by
 * rewriting prepares to the TEMP-table form. Installed once per memoized
 * plugin DB from the canvas editing backend so register.ts can stay byte-
 * identical to integration while FS-220 owns that file.
 */
export function installTaraListExclusionAccel(db: Database.Database): void {
  if (patchedDatabases.has(db)) return;
  patchedDatabases.add(db);
  // Ensure the TEMP table exists before any rewritten prepare compiles against it.
  loadTaraListExclusions(db, []);

  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const isPage = PAGE_JSON_EACH.test(sql);
    const isCount = COUNT_JSON_EACH.test(sql);
    if (!isPage && !isCount) return originalPrepare(sql);

    const rewritten = isPage
      ? sql.replace(
          PAGE_JSON_EACH,
          `AND entity_key NOT IN (SELECT entity_key FROM ${EXCLUDED_TABLE})`,
        )
      : sql.replace(
          COUNT_JSON_EACH,
          `WHERE entity_key NOT IN (SELECT entity_key FROM ${EXCLUDED_TABLE})`,
        );
    const statement = originalPrepare(rewritten);
    return {
      all(...params: unknown[]) {
        if (isPage) {
          loadTaraListExclusions(
            db,
            parseExcludedJson(params[params.length - 2]),
          );
          return statement.all(
            ...params.slice(0, -2),
            params[params.length - 1],
          );
        }
        return statement.all(...params);
      },
      get(...params: unknown[]) {
        if (isCount) {
          loadTaraListExclusions(
            db,
            parseExcludedJson(params[params.length - 1]),
          );
          return statement.get(...params.slice(0, -1));
        }
        return statement.get(...params);
      },
    };
  }) as Database.Database["prepare"];
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanvasTaraKind(value: unknown): value is TaraKind {
  return (
    value === "component" ||
    value === "zone" ||
    value === "asset" ||
    value === "dataflow" ||
    value === "threat"
  );
}

function readTaraKind(value: unknown): TaraKind {
  if (!isUnknownRecord(value)) throw new Error("TARA list input is invalid");
  const kind = value.kind;
  if (!isCanvasTaraKind(kind)) {
    throw new Error("TARA list kind is invalid");
  }
  return kind;
}

function assertFoundationFilters(value: unknown): void {
  if (!isUnknownRecord(value)) throw new Error("TARA list input is invalid");
  const filters = value.filters;
  if (!isUnknownRecord(filters))
    throw new Error("TARA list filters are invalid");
  if (Object.keys(filters).length > 0) {
    throw new Error("TARA filters are not available in the WP-31 foundation");
  }
}

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(payload: string): Record<string, JsonValue> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new Error("Cached TARA payload is not valid JSON");
  }
  const parsed = jsonValueSchema.parse(decoded);
  if (!isJsonRecord(parsed)) {
    throw new Error("Cached TARA payload must be an object");
  }
  return parsed;
}

function payloadLabel(
  payload: Record<string, JsonValue>,
  fallback: string,
): string {
  for (const key of ["label", "name", "title", "slug"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

function decodeContinuation(continuation: string | null): string {
  if (!continuation) return "";
  try {
    const decoded = Buffer.from(continuation, "base64url").toString("utf8");
    if (decoded.length === 0 || decoded.length > 512) {
      throw new Error("invalid length");
    }
    return decoded;
  } catch {
    throw new Error("TARA continuation token is invalid");
  }
}

function encodeContinuation(entityKey: string): string {
  return Buffer.from(entityKey, "utf8").toString("base64url");
}

function emptyCache(baseRevision = 0) {
  return {
    state: "empty" as const,
    asOf: null,
    message: "No accepted product-security cache is available.",
    acceptedGenerationId: null,
    baseRevision,
  };
}

async function projectSource(
  bb: BbPluginApi,
  projectId: string,
): Promise<CanvasProjectSource> {
  const project = await bb.sdk.projects.get({ projectId });
  const source =
    project.sources.find((candidate) => candidate.isDefault) ??
    project.sources[0];
  if (!source) throw new Error("The project has no local workspace source.");
  return { hostId: source.hostId, path: source.path };
}

function compareTaraSlug(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const CACHE_MESSAGE_MAX_LENGTH = 500;
const CACHE_MESSAGE_BASE_MAX_LENGTH = 100;
const DIAGNOSTIC_ENTRY_MAX_LENGTH = 110;
const UNSAFE_CACHE_DETAIL_PATTERN =
  /(?:https?:\/\/[^\s"'<>]*[?@][^\s"'<>]*|authorization(?:\s*[:=]\s*|\s+)(?:bearer\s+)?[^\s"'<>]+|bearer\s+[^\s"'<>]+|(?:api[_-]?key|token)(?:\s*[:=]\s*|\s+)[^\s"'<>]+|authorization|api[_-]?key|token=)/giu;

function sanitizeCacheDetail(value: string): string {
  return value
    .replace(UNSAFE_CACHE_DETAIL_PATTERN, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
}

function compactDetail(value: string, maxLength: number): string {
  const safe = sanitizeCacheDetail(value);
  if (safe.length <= maxLength) return safe;
  if (maxLength <= 1) return safe.slice(0, maxLength);
  const suffixLength = Math.min(12, Math.floor((maxLength - 1) / 2));
  const prefixLength = maxLength - suffixLength - 1;
  return sanitizeCacheDetail(
    `${safe.slice(0, prefixLength)}…${safe.slice(-suffixLength)}`,
  );
}

function diagnosticFileLabel(file: string, maxLength: number): string {
  const normalized = file.replaceAll("\\", "/");
  const name = basename(normalized) || "unknown.yaml";
  if (sanitizeCacheDetail(name) !== name) {
    const extension = sanitizeCacheDetail(extname(name));
    const fingerprint = createHash("sha256")
      .update(name)
      .digest("hex")
      .slice(0, 8);
    return compactDetail(
      `[redacted]-${fingerprint}${extension === extname(name) ? extension : ""}`,
      maxLength,
    );
  }
  return compactDetail(name, maxLength);
}

function diagnosticEntry(
  diagnostic: CanvasFileDiagnostic,
  maxLength: number,
): string {
  if (diagnostic.code === "UNSUPPORTED_ASSET_TYPE") {
    const prefix = "Unsupported asset type in authored file ";
    const file = diagnosticFileLabel(
      diagnostic.file,
      Math.max(12, Math.min(56, maxLength - prefix.length - 1)),
    );
    const withoutValue = `${prefix}${file}.`;
    const value = compactDetail(diagnostic.value ?? "unknown", 24);
    const withValue = `Unsupported asset type “${value}” in authored file ${file}.`;
    return withValue.length <= maxLength ? withValue : withoutValue;
  }
  if (diagnostic.code === "UNSUPPORTED_COMPONENT_TYPE") {
    const prefix = "Unsupported component type in authored file ";
    const file = diagnosticFileLabel(
      diagnostic.file,
      Math.max(12, Math.min(56, maxLength - prefix.length - 1)),
    );
    const withoutValue = `${prefix}${file}.`;
    const value = compactDetail(diagnostic.value ?? "unknown", 24);
    const withValue = `Unsupported component type “${value}” in authored file ${file}.`;
    return withValue.length <= maxLength ? withValue : withoutValue;
  }
  if (diagnostic.code === "RETIRED_COMPONENT_TYPE") {
    const prefix =
      "Retired component type requires migration in authored file ";
    const file = diagnosticFileLabel(
      diagnostic.file,
      Math.max(12, Math.min(56, maxLength - prefix.length - 1)),
    );
    const withoutValue = `${prefix}${file}.`;
    const value = compactDetail(diagnostic.value ?? "unknown", 24);
    const withValue = `Retired component type “${value}” requires migration in authored file ${file}.`;
    return withValue.length <= maxLength ? withValue : withoutValue;
  }
  const prefix = "Invalid working YAML quarantined at ";
  const file = diagnosticFileLabel(
    diagnostic.file,
    Math.max(12, Math.min(56, maxLength - prefix.length - 1)),
  );
  const required = `Invalid working YAML quarantined at ${file}.`;
  const reasonBudget = maxLength - required.length - " Reason: ".length;
  if (reasonBudget < 16) return required;
  const reason = compactDetail(diagnostic.message, reasonBudget);
  return `${required} Reason: ${reason}`;
}

function moreDiagnosticsTail(count: number): string {
  return count > 0
    ? ` +${count} more diagnostic${count === 1 ? "" : "s"}.`
    : "";
}

function diagnosticGroupMessage(
  diagnostics: readonly CanvasFileDiagnostic[],
  maxLength: number,
): string {
  const first = diagnostics[0];
  if (!first) return "";
  let shown = 1;
  let tail = moreDiagnosticsTail(diagnostics.length - shown);
  const entries = [diagnosticEntry(first, maxLength - tail.length)];
  while (shown < diagnostics.length) {
    const candidate = diagnosticEntry(
      diagnostics[shown]!,
      DIAGNOSTIC_ENTRY_MAX_LENGTH,
    );
    const candidateTail = moreDiagnosticsTail(diagnostics.length - shown - 1);
    const candidateLength =
      entries.join(" ").length + 1 + candidate.length + candidateTail.length;
    if (candidateLength > maxLength) break;
    entries.push(candidate);
    shown += 1;
    tail = candidateTail;
  }
  return `${entries.join(" ")}${tail}`;
}

function workingDiagnosticMessage(
  baseMessage: string | null,
  diagnostics: readonly CanvasFileDiagnostic[],
): string | null {
  const diagnosticCodes: readonly CanvasFileDiagnostic["code"][] = [
    "UNSUPPORTED_ASSET_TYPE",
    "UNSUPPORTED_COMPONENT_TYPE",
    "RETIRED_COMPONENT_TYPE",
    "INVALID_AUTHORED_YAML",
  ];
  const diagnosticGroups = diagnosticCodes.flatMap((code) => {
    const matching = diagnostics.filter(
      (diagnostic) => diagnostic.code === code,
    );
    return matching.length > 0 ? [matching] : [];
  });
  const safeBase = baseMessage
    ? compactDetail(baseMessage, CACHE_MESSAGE_BASE_MAX_LENGTH)
    : null;
  const segmentCount = diagnosticGroups.length + (safeBase ? 1 : 0);
  if (segmentCount === 0) return null;
  const separatorsLength = segmentCount - 1;
  const groupsBudget =
    CACHE_MESSAGE_MAX_LENGTH - (safeBase?.length ?? 0) - separatorsLength;
  const baseGroupBudget =
    diagnosticGroups.length > 0
      ? Math.floor(groupsBudget / diagnosticGroups.length)
      : 0;
  let remainingBudget = groupsBudget;
  const groups = diagnosticGroups.map((group, index) => {
    const remainingGroups = diagnosticGroups.length - index;
    const budget =
      index === diagnosticGroups.length - 1
        ? remainingBudget
        : Math.max(
            baseGroupBudget,
            Math.floor(remainingBudget / remainingGroups),
          );
    remainingBudget -= budget;
    return diagnosticGroupMessage(group, budget);
  });
  const message = [safeBase, ...groups].filter(Boolean).join(" ");
  const validated = cacheStateSchema.shape.message.safeParse(message);
  if (validated.success) return validated.data;

  const counts = diagnosticCodes.flatMap((code) => {
    const count = diagnostics.filter(
      (diagnostic) => diagnostic.code === code,
    ).length;
    if (count === 0) return [];
    if (code === "UNSUPPORTED_ASSET_TYPE") {
      return [`Unsupported asset types: ${count}.`];
    }
    if (code === "UNSUPPORTED_COMPONENT_TYPE") {
      return [`Unsupported component types: ${count}.`];
    }
    if (code === "RETIRED_COMPONENT_TYPE") {
      return [`Retired component types requiring migration: ${count}.`];
    }
    return [`Invalid working YAML files quarantined: ${count}.`];
  });
  const fallback = [
    ...(baseMessage
      ? ["Product-security refresh failed; showing accepted cache."]
      : []),
    ...counts,
  ].join(" ");
  const validatedFallback = cacheStateSchema.shape.message.safeParse(fallback);
  return validatedFallback.success ? validatedFallback.data : null;
}

/**
 * Canvas-owned taraList. Exclusion filtering uses {@link loadTaraListExclusions}
 * (FS-142 N2) so product-security/register.ts does not own this query shape.
 */
export async function listTara(
  bb: BbPluginApi,
  db: Database.Database,
  input: {
    projectId: string;
    projectVersionId: string | null;
    pageSize?: number;
    continuation?: string | null;
    kind?: unknown;
    filters?: unknown;
  },
  identities: {
    workspaceProjectId: string;
    platformProjectId: string;
    includeAccepted?: boolean;
  } = {
    workspaceProjectId: input.projectId,
    platformProjectId: input.projectId,
  },
) {
  const kind = readTaraKind(input);
  assertFoundationFilters(input);
  const projectVersionId = toStorageProjectVersionId(input.projectVersionId);
  const sync =
    identities.includeAccepted !== false
      ? db
          .prepare<[string, string, string], TaraSyncRow>(
            `SELECT accepted_generation_id, base_revision, last_pull, error
             FROM sync_state
            WHERE project_id = ? AND project_version_id = ? AND entity_kind = ?`,
          )
          .get(identities.platformProjectId, projectVersionId, kind)
      : undefined;

  const pageSize = input.pageSize ?? 50;
  const afterKey = decodeContinuation(input.continuation ?? null);
  let working: StoredCanvasEntity[] = [];
  let diagnostics: CanvasFileDiagnostic[] = [];
  let source: CanvasProjectSource | null = null;
  try {
    source = await projectSource(bb, identities.workspaceProjectId);
  } catch {
    // An accepted base remains readable when this bb project has no bound
    // workspace source. With no base this is the explicit empty/unconfigured
    // state; no authored bytes are claimed or silently discarded.
  }
  if (source) {
    try {
      const files = createSdkCanvasFileStore(bb, source, {
        reclaimTombstones: false,
      });
      const listing = await files.listWithDiagnostics(kind);
      working = listing.entities;
      diagnostics = listing.diagnostics;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`INVALID_WORKING_TARA: ${detail}`);
    }
  }
  const deletedPrefix = canvasDeletedMarkerPrefix(
    identities.workspaceProjectId,
    input.projectVersionId,
    kind,
  );
  const deleted = new Set<string>();
  for (const key of await bb.storage.kv.list(deletedPrefix)) {
    try {
      deleted.add(decodeURIComponent(key.slice(deletedPrefix.length)));
    } catch {
      throw new Error(
        "INVALID_WORKING_TARA: a local deletion marker is malformed.",
      );
    }
  }
  const excluded = new Set([
    ...working.map((stored) => stored.entity.slug),
    ...diagnostics.map((diagnostic) => diagnostic.slug),
    ...deleted,
  ]);
  const visibleWorking = working.filter(
    (stored) => !deleted.has(stored.entity.slug),
  );
  // Materialize exclusions once into a temp table instead of re-parsing
  // json_each(?) per candidate row in both the page and count queries (FS-142 N2).
  loadTaraListExclusions(db, excluded);
  const rows = sync?.accepted_generation_id
    ? db
        .prepare<
          [string, string, string, string, string, number],
          TaraSnapshotRow
        >(
          `SELECT entity_key, payload
             FROM (
               SELECT COALESCE(
                        NULLIF(json_extract(payload, '$.slug'), ''),
                        entity_key
                      ) AS entity_key,
                      payload
                 FROM base_snapshot
                WHERE project_id = ? AND project_version_id = ?
                  AND entity_kind = ? AND generation_id = ?
             )
            WHERE entity_key COLLATE BINARY > ?
              AND entity_key NOT IN (SELECT entity_key FROM ${EXCLUDED_TABLE})
            ORDER BY entity_key COLLATE BINARY
            LIMIT ?`,
        )
        .all(
          identities.platformProjectId,
          projectVersionId,
          kind,
          sync.accepted_generation_id,
          afterKey,
          pageSize + 1,
        )
    : [];
  const acceptedTotal = sync?.accepted_generation_id
    ? (db
        .prepare<[string, string, string, string], TaraTotalRow>(
          `SELECT COUNT(*) AS total
             FROM (
               SELECT COALESCE(
                        NULLIF(json_extract(payload, '$.slug'), ''),
                        entity_key
                      ) AS entity_key
                 FROM base_snapshot
                WHERE project_id = ? AND project_version_id = ?
                  AND entity_kind = ? AND generation_id = ?
             )
            WHERE entity_key NOT IN (SELECT entity_key FROM ${EXCLUDED_TABLE})`,
        )
        .get(
          identities.platformProjectId,
          projectVersionId,
          kind,
          sync.accepted_generation_id,
        )?.total ?? 0)
    : 0;
  const mergedRows: Array<[string, Record<string, JsonValue>]> = [];
  for (const row of rows) {
    const fields = parsePayload(row.payload);
    mergedRows.push([row.entity_key, fields]);
  }
  for (const stored of visibleWorking) {
    const fields = jsonValueSchema.parse(
      architectureEntityPayload(stored.entity),
    );
    if (!isJsonRecord(fields)) {
      throw new Error(
        `INVALID_WORKING_TARA: ${stored.file} must contain a mapping.`,
      );
    }
    mergedRows.push([stored.entity.slug, fields]);
  }
  mergedRows.splice(
    0,
    mergedRows.length,
    ...mergedRows
      .filter(([slug]) => compareTaraSlug(slug, afterKey) > 0)
      .sort(([left], [right]) => compareTaraSlug(left, right)),
  );
  const visibleRows = mergedRows.slice(0, pageSize);
  const next =
    mergedRows.length > pageSize && visibleRows.length > 0
      ? encodeContinuation(visibleRows[visibleRows.length - 1]![0])
      : null;
  const cacheState: "stale" | "fresh" =
    sync?.error || diagnostics.length > 0 ? "stale" : "fresh";
  const cacheMessage = workingDiagnosticMessage(
    sync?.error
      ? "The last product-security refresh failed; showing accepted cache."
      : null,
    diagnostics,
  );
  const total = acceptedTotal + visibleWorking.length;

  return {
    items: visibleRows.map(([slug, fields]) => {
      return {
        projectId: input.projectId,
        projectVersionId: input.projectVersionId,
        kind,
        key: slug,
        label: payloadLabel(fields, slug),
        fields,
      };
    }),
    total,
    next,
    cache: sync?.accepted_generation_id
      ? {
          state: cacheState,
          asOf: sync.last_pull,
          message: cacheMessage,
          acceptedGenerationId: sync.accepted_generation_id,
          baseRevision: sync.base_revision,
        }
      : diagnostics.length > 0
        ? {
            state: "stale" as const,
            asOf: null,
            message: cacheMessage,
            acceptedGenerationId: null,
            baseRevision: sync?.base_revision ?? 0,
          }
        : emptyCache(sync?.base_revision),
  };
}
