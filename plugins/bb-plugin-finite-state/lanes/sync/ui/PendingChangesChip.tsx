import { useEffect, useState } from "react";
import { Badge } from "@bb/shared-ui/badge";
import { Icon } from "@bb/shared-ui/icon";
import { useBbContext, useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import { ENTITIES, type EntityKind } from "../../../lib/sync/registry.js";
import type { rpcContract } from "../../../shared/contract.js";

export interface PendingChangesChipProps {
  scope: { projectId: string; pvId: string | null };
  surface?: EntityKind | "all";
}

interface PendingCounts {
  local: number;
  conflicts: number;
}

interface PendingResult {
  requestKey: string;
  counts: PendingCounts | null;
  error: { code: string; detail: string } | null;
}

const SYNC_ROUTE_IDENTIFIER = /^[A-Za-z0-9@][A-Za-z0-9._:@-]{0,511}$/u;
const ERROR_CODE_PREFIX = /^([A-Z][A-Z0-9_]{2,80}):\s*/u;
const URL = /https?:\/\/[^\s)]+/giu;

function syncUnavailableDiagnostic(cause: unknown): {
  code: string;
  detail: string;
} {
  const raw =
    cause instanceof Error && cause.message.length > 0
      ? cause.message
      : "Sync status could not be loaded.";
  const match = ERROR_CODE_PREFIX.exec(raw);
  const code = match?.[1] ?? "SYNC_STATUS_UNAVAILABLE";
  const detail = raw
    .slice(match?.[0].length ?? 0)
    .replaceAll(URL, "the configured remote endpoint")
    .slice(0, 300);
  return { code, detail };
}

export function isSyncRouteIdentifier(value: string): boolean {
  return SYNC_ROUTE_IDENTIFIER.test(value);
}

function isEntityKind(value: string): value is EntityKind {
  return Object.hasOwn(ENTITIES, value);
}

export function syncScopeSubPath(
  scope: PendingChangesChipProps["scope"],
  surface: PendingChangesChipProps["surface"] = "all",
): string {
  if (
    !isSyncRouteIdentifier(scope.projectId) ||
    (scope.pvId !== null && !isSyncRouteIdentifier(scope.pvId)) ||
    (surface !== "all" && !isEntityKind(surface))
  ) {
    throw new Error("Invalid Sync review route scope");
  }
  const base = `scope/${scope.projectId}/${scope.pvId ?? "@project"}`;
  return surface === "all" ? base : `${base}/surface/${surface}`;
}

export function PendingChangesChip({
  scope,
  surface = "all",
}: PendingChangesChipProps): React.JSX.Element {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { projectId: workspaceProjectId } = useBbContext();
  const [result, setResult] = useState<PendingResult | null>(null);
  const validScope =
    isSyncRouteIdentifier(scope.projectId) &&
    (scope.pvId === null || isSyncRouteIdentifier(scope.pvId)) &&
    (surface === "all" || isEntityKind(surface));
  const requestKey = `${scope.projectId}\0${scope.pvId ?? "@project"}\0${surface}`;

  useEffect(() => {
    if (!validScope) return;
    let cancelled = false;
    void rpc
      .call("syncStatus", {
        projectId: scope.projectId,
        projectVersionId: scope.pvId,
        ...(workspaceProjectId ? { workspaceProjectId } : {}),
        ...(surface === "all" ? {} : { kinds: [surface] }),
      })
      .then((status) => {
        if (cancelled) return;
        setResult({
          requestKey,
          counts: {
            local: status.local.length,
            conflicts: status.conflicts.length,
          },
          error: null,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setResult({
          requestKey,
          counts: null,
          error: syncUnavailableDiagnostic(cause),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    requestKey,
    rpc,
    scope.projectId,
    scope.pvId,
    surface,
    validScope,
    workspaceProjectId,
  ]);

  const currentResult = result?.requestKey === requestKey ? result : null;
  const counts = currentResult?.counts ?? null;
  const error = currentResult?.error ?? null;
  const unavailableReason = !validScope
    ? { code: "INVALID_SCOPE", detail: "The Sync scope is invalid." }
    : error;
  const unavailable = unavailableReason !== null;
  const label = unavailable
    ? `Sync unavailable · ${unavailableReason.code}`
    : counts
      ? `${counts.local} local · ${counts.conflicts} ${counts.conflicts === 1 ? "conflict" : "conflicts"}`
      : "Checking local changes";
  const accessibleLabel = unavailable
    ? `Open Sync review; pending change count unavailable: ${unavailableReason.code}. ${unavailableReason.detail}`
    : counts
      ? `Open Sync review: ${counts.local} local changes and ${counts.conflicts} ${counts.conflicts === 1 ? "conflict" : "conflicts"}`
      : "Open Sync review; checking pending changes";

  return (
    <button
      aria-label={accessibleLabel}
      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      disabled={!validScope}
      title={unavailableReason?.detail}
      onClick={() =>
        navigate.toPluginPanel("sync", {
          subPath: syncScopeSubPath(scope, surface),
        })
      }
      type="button"
    >
      <Icon
        aria-hidden="true"
        className={counts === null && !unavailable ? "animate-spin" : undefined}
        name={
          unavailable ? "AlertCircle" : counts === null ? "Loading" : "FileDiff"
        }
      />
      <span>{label}</span>
      {counts && counts.conflicts > 0 ? (
        <Badge className="h-4 px-1 font-mono text-xs" variant="destructive">
          {counts.conflicts}
        </Badge>
      ) : null}
    </button>
  );
}
