export interface BomVersionLabelInput {
  platformProjectId: string;
  platformProjectName: string | null;
  projectVersionId: string;
  projectVersionName: string | null;
  state: "fresh" | "stale";
}

export function bomVersionLabel(version: BomVersionLabelInput): string {
  const suffix = version.state === "stale" ? " · stale" : "";
  if (
    version.platformProjectName === null &&
    version.projectVersionName === null
  ) {
    return `${version.platformProjectId} / ${version.projectVersionId}${suffix}`;
  }
  return `${version.platformProjectName ?? version.platformProjectId} · ${version.projectVersionName ?? version.projectVersionId} — ${version.platformProjectId} / ${version.projectVersionId}${suffix}`;
}
