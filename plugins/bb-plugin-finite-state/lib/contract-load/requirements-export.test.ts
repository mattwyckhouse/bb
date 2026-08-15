import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { reqIdKey } from "../sync/registry.js";
import { MIGRATIONS } from "../store/schema.js";
import type { Store } from "../store/index.js";
import {
  CANONICAL_REQUIREMENTS_ROOT,
  canonicalRequirementSourcePath,
  exportRequirementBindings,
  indexRequirementBindingsByStableKey,
} from "./requirements-export.js";

function openMemoryStore(): Store {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration);
  return {
    db,
    tx<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

const SCOPE = {
  projectId: "fs-local-repo:deadbeef",
  projectVersionId: "fs-local-checkout:deadbeef",
} as const;

const REQUIREMENT_PAYLOAD = {
  schema: "fs-requirement/v1",
  id: "REQ-UNIT",
  req_type: "security",
  priority: "P1",
  status: "approved",
  ears: {
    pattern: "ubiquitous",
    text: "The gateway SHALL reject unsigned firmware",
    parts: {
      system: "gateway",
      response: "reject unsigned firmware",
    },
  },
  source_description: "Unit projection fixture.",
  mitigations: ["mit-signed-update"],
  controls: ["ctrl-secure-boot"],
  standards: ["iec-62443-4-2"],
  verification: [
    {
      check: "check-firmware-signature",
      method: "binary_analysis",
      tier: "static",
      required: true,
      pass_criteria: "Signed images only.",
    },
  ],
} as const;

function seedProjection(
  store: Store,
  options: {
    readonly payload?: unknown;
    readonly sourcePath?: string;
    readonly generationId?: string;
  } = {},
): void {
  const generationId = options.generationId ?? "contract-load-unit";
  const payload = options.payload ?? REQUIREMENT_PAYLOAD;
  const entityKey = reqIdKey({ reqId: REQUIREMENT_PAYLOAD.id });
  const pulledAt = "2026-08-14T00:00:00.000Z";
  store.tx(() => {
    store.db
      .prepare(
        `INSERT INTO pull_generation
           (project_id, project_version_id, generation_id, status,
            requested_kinds_json, started_at, completed_at, accepted_at)
         VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?)`,
      )
      .run(
        SCOPE.projectId,
        SCOPE.projectVersionId,
        generationId,
        JSON.stringify(["requirement"]),
        pulledAt,
        pulledAt,
        pulledAt,
      );
    store.db
      .prepare(
        `INSERT INTO sync_state
           (project_id, project_version_id, entity_kind,
            accepted_generation_id, staging_generation_id, base_revision,
            staging_continuation, staged_pages, staged_rows,
            staged_quarantined, last_pull, error)
         VALUES (?, ?, 'requirement', ?, NULL, 1, NULL, 0, 0, 0, ?, NULL)`,
      )
      .run(SCOPE.projectId, SCOPE.projectVersionId, generationId, pulledAt);
    store.db
      .prepare(
        `INSERT INTO base_snapshot
           (project_id, project_version_id, entity_kind, generation_id,
            entity_key, remote_id, payload, content_hash, pulled_at)
         VALUES (?, ?, 'requirement', ?, ?, NULL, ?, 'abc', ?)`,
      )
      .run(
        SCOPE.projectId,
        SCOPE.projectVersionId,
        generationId,
        entityKey,
        JSON.stringify(payload),
        pulledAt,
      );
    if (options.sourcePath !== undefined) {
      store.db
        .prepare(
          `INSERT INTO verification_checks
             (project_id, project_version_id, generation_id, check_id, code,
              name, check_type, category, description, pass_criteria,
              fail_criteria, input_description, parameters, default_sla_days,
              deleted_at, review_status, review_version, raw, pulled_at)
           VALUES (?, ?, ?, 'check-firmware-signature',
                   'check-firmware-signature', 'check-firmware-signature',
                   'binary_analysis', 'static', NULL, 'ok', NULL, NULL, NULL,
                   NULL, NULL, NULL, '0', ?, ?)`,
        )
        .run(
          SCOPE.projectId,
          SCOPE.projectVersionId,
          generationId,
          JSON.stringify({
            requirementId: REQUIREMENT_PAYLOAD.id,
            source: options.sourcePath,
          }),
          pulledAt,
        );
      store.db
        .prepare(
          `INSERT INTO requirement_check_mappings
             (project_id, project_version_id, generation_id, requirement_key,
              check_id, is_required, coverage_level, suppressed, raw, pulled_at)
           VALUES (?, ?, ?, ?, 'check-firmware-signature', 1, 'full', 0, ?, ?)`,
        )
        .run(
          SCOPE.projectId,
          SCOPE.projectVersionId,
          generationId,
          entityKey,
          JSON.stringify({
            requirementId: REQUIREMENT_PAYLOAD.id,
            source: options.sourcePath,
          }),
          pulledAt,
        );
    }
  });
}

describe("exportRequirementBindings", () => {
  it("exports stable key, EARS text, status, and canonical provenance from an in-memory projection", () => {
    const store = openMemoryStore();
    seedProjection(store);

    const rows = exportRequirementBindings(store, SCOPE);
    expect(rows).toEqual([
      {
        stableKey: "REQ-UNIT",
        earsText: "The gateway SHALL reject unsigned firmware",
        status: "approved",
        sourcePath: canonicalRequirementSourcePath("REQ-UNIT"),
      },
    ]);
    expect(
      rows[0]?.sourcePath.startsWith(`${CANONICAL_REQUIREMENTS_ROOT}/`),
    ).toBe(true);
  });

  it("prefers projection-recorded source paths when present", () => {
    const store = openMemoryStore();
    seedProjection(store, {
      sourcePath: ".fs/requirements/REQ-UNIT.yaml",
    });

    expect(exportRequirementBindings(store, SCOPE)).toEqual([
      {
        stableKey: "REQ-UNIT",
        earsText: "The gateway SHALL reject unsigned firmware",
        status: "approved",
        sourcePath: ".fs/requirements/REQ-UNIT.yaml",
      },
    ]);
  });

  it("returns an empty list when the projection has no accepted requirement generation", () => {
    const store = openMemoryStore();
    expect(exportRequirementBindings(store, SCOPE)).toEqual([]);
  });

  it("indexes bindings by stable key for the Code Assurance consumption stand-in", () => {
    const store = openMemoryStore();
    seedProjection(store);
    const index = indexRequirementBindingsByStableKey(
      exportRequirementBindings(store, SCOPE),
    );
    expect(index.get("REQ-UNIT")?.earsText).toBe(
      "The gateway SHALL reject unsigned firmware",
    );
    expect(index.has("missing")).toBe(false);
  });
});
