import { validateRequirement } from "../../lanes/product-security/requirements/cards/validator.js";
import type { Store } from "../store/index.js";
import type { ContractLoadScope } from "./loader.js";

/**
 * Canonical authored root for requirements YAML (owner-confirmed reading of
 * AUTHORITY ".fs/requirements" — see fact-fs-requirements-canonical-root).
 */
export const CANONICAL_REQUIREMENTS_ROOT = "product-security/requirements";

export interface RequirementBindingRow {
  readonly stableKey: string;
  readonly earsText: string;
  readonly status: string;
  readonly sourcePath: string;
}

interface AcceptedGenerationRow {
  generation_id: string | null;
}

interface SnapshotRow {
  entity_key: string;
  payload: string;
}

interface MappingRawRow {
  requirement_key: string;
  raw: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourceFromMappingRaw(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const source = parsed["source"];
  return typeof source === "string" && source.length > 0 ? source : null;
}

export function canonicalRequirementSourcePath(requirementId: string): string {
  return `${CANONICAL_REQUIREMENTS_ROOT}/${requirementId}.yaml`;
}

/**
 * Read-side adapter over the WP-99 accepted requirement projection.
 * Returns one binding row per projected requirement: stable key, EARS text,
 * workflow status, and source-file provenance when the projection recorded it.
 */
export function exportRequirementBindings(
  store: Store,
  scope: ContractLoadScope,
): readonly RequirementBindingRow[] {
  const state = store.db
    .prepare<[string, string], AcceptedGenerationRow>(
      `SELECT accepted_generation_id AS generation_id
         FROM sync_state
        WHERE project_id = ?
          AND project_version_id = ?
          AND entity_kind = 'requirement'`,
    )
    .get(scope.projectId, scope.projectVersionId);
  const generationId = state?.generation_id;
  if (generationId === null || generationId === undefined) return [];

  const sourceByKey = new Map<string, string>();
  const mappingRows = store.db
    .prepare<[string, string, string], MappingRawRow>(
      `SELECT requirement_key, raw
         FROM requirement_check_mappings
        WHERE project_id = ?
          AND project_version_id = ?
          AND generation_id = ?
        ORDER BY requirement_key, check_id`,
    )
    .all(scope.projectId, scope.projectVersionId, generationId);
  for (const mapping of mappingRows) {
    if (sourceByKey.has(mapping.requirement_key)) continue;
    const source = sourceFromMappingRaw(mapping.raw);
    if (source !== null) sourceByKey.set(mapping.requirement_key, source);
  }

  const snapshots = store.db
    .prepare<[string, string, string], SnapshotRow>(
      `SELECT entity_key, payload
         FROM base_snapshot
        WHERE project_id = ?
          AND project_version_id = ?
          AND entity_kind = 'requirement'
          AND generation_id = ?
        ORDER BY entity_key`,
    )
    .all(scope.projectId, scope.projectVersionId, generationId);

  const rows: RequirementBindingRow[] = [];
  for (const snapshot of snapshots) {
    let value: unknown;
    try {
      value = JSON.parse(snapshot.payload);
    } catch {
      continue;
    }
    const validated = validateRequirement(value);
    if (!validated.success) continue;
    const requirement = validated.data;
    rows.push({
      stableKey: requirement.id,
      earsText: requirement.ears.text,
      status: requirement.status,
      sourcePath:
        sourceByKey.get(snapshot.entity_key) ??
        canonicalRequirementSourcePath(requirement.id),
    });
  }
  return rows;
}

/**
 * Closest in-repo stand-in for the fs-cli / SEI Code Assurance consumption
 * path: index bound requirements by stable key so downstream lookup is
 * path-independent. Duplicate keys keep the first row (projection load already
 * refuses duplicates with a named diagnostic).
 */
export function indexRequirementBindingsByStableKey(
  rows: readonly RequirementBindingRow[],
): ReadonlyMap<string, RequirementBindingRow> {
  const index = new Map<string, RequirementBindingRow>();
  for (const row of rows) {
    if (index.has(row.stableKey)) continue;
    index.set(row.stableKey, row);
  }
  return index;
}
