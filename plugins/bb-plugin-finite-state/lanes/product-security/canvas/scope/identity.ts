import type Database from "better-sqlite3";

import { REPO_LOCAL_PROJECT_ID_PREFIX } from "../../../../lib/contract-load/projection-key.js";

interface BindingRow {
  found: number;
}

export function workspacePlatformProjectIsBound(
  db: Database.Database,
  workspaceProjectId: string,
  platformProjectId: string,
): boolean {
  // Repo-local checkout projections are inherent to the workspace path, not
  // Sync-selected Platform associations. Requiring a binding row would either
  // spend the legacy one-shot backfill or force a Sync picker that cannot
  // enumerate synthetic scopes.
  if (platformProjectId.startsWith(REPO_LOCAL_PROJECT_ID_PREFIX)) {
    return true;
  }
  return (
    db
      .prepare<[string, string], BindingRow>(
        `SELECT 1 AS found
           FROM workspace_platform_project_binding
          WHERE workspace_project_id = ? AND platform_project_id = ?
          LIMIT 1`,
      )
      .get(workspaceProjectId, platformProjectId)?.found === 1
  );
}

export function assertWorkspacePlatformProjectBinding(
  db: Database.Database,
  workspaceProjectId: string,
  platformProjectId: string,
): void {
  if (
    !workspacePlatformProjectIsBound(db, workspaceProjectId, platformProjectId)
  ) {
    throw new Error(
      "The selected workspace is not associated with that Platform project. Open Sync and select the project before using version-scoped TARA.",
    );
  }
}
