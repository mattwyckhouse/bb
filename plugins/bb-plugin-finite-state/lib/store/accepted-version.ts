import type Database from "better-sqlite3";
import {
  fromStorageProjectVersionId,
  PROJECT_LEVEL_VERSION_ID,
} from "./index.js";

interface VersionRow {
  project_version_id: string;
}

/**
 * Newest accepted `sync_state` version for one entity kind.
 * When `requestedProjectVersionId` is omitted, `last_pull DESC` wins and
 * `project_version_id DESC` breaks ties. Project-level `@project` rows are
 * excluded; callers that already pinned a version keep that pin.
 */
export function resolveNewestAcceptedProjectVersionId(
  db: Database.Database,
  projectId: string,
  requestedProjectVersionId: string | null,
  entityKind: string,
): string | null {
  if (requestedProjectVersionId !== null) return requestedProjectVersionId;
  const row = db
    .prepare<[string, string, string], VersionRow>(
      `SELECT project_version_id
         FROM sync_state
        WHERE project_id = ? AND entity_kind = ?
          AND project_version_id <> ? AND accepted_generation_id IS NOT NULL
        ORDER BY last_pull DESC, project_version_id DESC
        LIMIT 1`,
    )
    .get(projectId, entityKind, PROJECT_LEVEL_VERSION_ID);
  return row ? fromStorageProjectVersionId(row.project_version_id) : null;
}
