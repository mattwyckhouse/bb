import { REPO_LOCAL_PROJECT_ID_PREFIX } from "../../../lib/contract-load/projection-key.js";

export type SyncScopeValidationErrorCode = "REPO_LOCAL_SCOPE_NOT_SYNCABLE";

export class SyncScopeValidationError extends Error {
  constructor(
    readonly code: SyncScopeValidationErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SyncScopeValidationError";
  }
}

export function assertRemoteSyncScope(projectId: string): void {
  if (!projectId.startsWith(REPO_LOCAL_PROJECT_ID_PREFIX)) return;
  throw new SyncScopeValidationError(
    "REPO_LOCAL_SCOPE_NOT_SYNCABLE",
    "This is a repo-local checkout projection, so there is nothing to sync; repository YAML is the source of truth.",
  );
}
