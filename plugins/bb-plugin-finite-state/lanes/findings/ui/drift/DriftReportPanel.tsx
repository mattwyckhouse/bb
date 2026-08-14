import { useCallback, useEffect, useMemo, useState } from "react";
import { useRealtime, useRpc } from "@bb/plugin-sdk/app";

import {
  FINDINGS_DRIFT_CHANGED_CHANNEL,
  type DriftReport,
} from "../../drift/report.js";
import type { findingsUiRpcContract } from "../../rpc.js";

interface DriftReportPanelProps {
  workspaceProjectId: string | null;
  platformProjectId: string | null;
  projectVersionId: string | null;
}

interface PrunePreview {
  baseStateSha256: string;
  stableKeys: string[];
  selected: number;
}

const DRIFT_LABELS: Record<keyof DriftReport["totals"], string> = {
  reattached_noop: "Reattached",
  reapply: "Reapply",
  stale: "Stale",
  orphaned: "Orphaned",
  conflict: "Conflicts",
  needs_completion: "Needs completion",
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The drift operation failed.";
}

export function DriftReportPanel({
  workspaceProjectId,
  platformProjectId,
  projectVersionId,
}: DriftReportPanelProps): React.JSX.Element {
  const rpc = useRpc<typeof findingsUiRpcContract>();
  const [report, setReport] = useState<DriftReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [vendor, setVendor] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [importing, setImporting] = useState(false);
  const [prunePreview, setPrunePreview] = useState<PrunePreview | null>(null);
  const scopeReady = Boolean(
    workspaceProjectId && platformProjectId && projectVersionId,
  );

  const loadReport = useCallback(
    async (cursor: string | null = null) => {
      if (!platformProjectId || !projectVersionId) return;
      cursor ? setLoadingMore(true) : setLoading(true);
      setError(null);
      try {
        const next = await rpc.call("findingsDriftReport", {
          platformProjectId,
          projectVersionId,
          cursor,
          limit: 100,
        });
        setRefreshRequired(false);
        setReport((current) =>
          cursor && current
            ? {
                ...next,
                items: [...current.items, ...next.items],
              }
            : next,
        );
      } catch (cause) {
        const detail = message(cause);
        if (detail.includes("DRIFT_REFRESH_REQUIRED")) {
          setRefreshRequired(true);
          setReport(null);
        } else {
          setError(detail);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [platformProjectId, projectVersionId, rpc],
  );

  useEffect(() => {
    setReport(null);
    setPrunePreview(null);
    setAction(null);
    if (scopeReady) void loadReport();
  }, [loadReport, scopeReady]);

  useRealtime(FINDINGS_DRIFT_CHANGED_CHANNEL, (payload) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      "pvId" in payload &&
      payload.pvId === projectVersionId
    ) {
      void loadReport();
    }
  });

  const orphanKeys = useMemo(
    () =>
      report?.items
        .filter((item) => item.state === "orphaned")
        .map((item) => item.stableKey) ?? [],
    [report],
  );

  const refresh = useCallback(async () => {
    if (!workspaceProjectId || !platformProjectId || !projectVersionId) return;
    setLoading(true);
    setError(null);
    setAction(null);
    try {
      const next = await rpc.call("findingsDriftRefresh", {
        workspaceProjectId,
        platformProjectId,
        projectVersionId,
      });
      setReport(next);
      setRefreshRequired(false);
      setPrunePreview(null);
      setAction(
        `Drift refreshed · ${next.items.length.toLocaleString()} items loaded`,
      );
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [platformProjectId, projectVersionId, rpc, workspaceProjectId]);

  const importVex = useCallback(
    async (dryRun: boolean) => {
      if (
        !workspaceProjectId ||
        !platformProjectId ||
        !projectVersionId ||
        !file ||
        !vendor.trim()
      ) {
        return;
      }
      setImporting(true);
      setError(null);
      setAction(null);
      try {
        const result = await rpc.call("findingsDriftImportVendorVex", {
          workspaceProjectId,
          platformProjectId,
          projectVersionId,
          fileName: file.name,
          document: await file.text(),
          vendor: vendor.trim(),
          overwrite,
          dryRun,
        });
        setAction(
          `${dryRun ? "Import preview" : "Vendor VEX imported"} · ${result.matched.toLocaleString()} matched · ${result.unmatched.toLocaleString()} unmatched · ${result.written.toLocaleString()} written`,
        );
        if (!dryRun && result.written > 0) await loadReport();
      } catch (cause) {
        setError(message(cause));
      } finally {
        setImporting(false);
      }
    },
    [
      file,
      loadReport,
      overwrite,
      platformProjectId,
      projectVersionId,
      rpc,
      vendor,
      workspaceProjectId,
    ],
  );

  const previewPrune = useCallback(async () => {
    if (
      !workspaceProjectId ||
      !platformProjectId ||
      !projectVersionId ||
      orphanKeys.length === 0
    ) {
      return;
    }
    setError(null);
    setAction(null);
    try {
      const state = await rpc.call("findingsDriftOrphanState", {
        platformProjectId,
        projectVersionId,
      });
      const preview = await rpc.call("findingsDriftPrune", {
        workspaceProjectId,
        platformProjectId,
        projectVersionId,
        stableKeys: orphanKeys,
        dryRun: true,
        confirmed: false,
        expectedBaseStateSha256: state.baseStateSha256,
      });
      setPrunePreview({
        baseStateSha256: state.baseStateSha256,
        stableKeys: orphanKeys,
        selected: preview.selected,
      });
    } catch (cause) {
      setError(message(cause));
    }
  }, [
    orphanKeys,
    platformProjectId,
    projectVersionId,
    rpc,
    workspaceProjectId,
  ]);

  const confirmPrune = useCallback(async () => {
    if (
      !workspaceProjectId ||
      !platformProjectId ||
      !projectVersionId ||
      !prunePreview
    ) {
      return;
    }
    setError(null);
    try {
      const result = await rpc.call("findingsDriftPrune", {
        workspaceProjectId,
        platformProjectId,
        projectVersionId,
        stableKeys: prunePreview.stableKeys,
        dryRun: false,
        confirmed: true,
        expectedBaseStateSha256: prunePreview.baseStateSha256,
      });
      setPrunePreview(null);
      setAction(`Pruned ${result.pruned.toLocaleString()} orphaned decisions`);
      await loadReport();
    } catch (cause) {
      setError(message(cause));
    }
  }, [
    loadReport,
    platformProjectId,
    projectVersionId,
    prunePreview,
    rpc,
    workspaceProjectId,
  ]);

  if (!scopeReady) {
    return (
      <div className="border-b border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        Choose a findings scope to inspect drift.
      </div>
    );
  }

  return (
    <details className="border-b border-border bg-card" open>
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        Drift report
        {report ? (
          <span className="ml-2 font-normal text-muted-foreground">
            {Object.values(report.totals)
              .reduce((total, count) => total + count, 0)
              .toLocaleString()}{" "}
            classified
          </span>
        ) : null}
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3 text-sm">
        {loading && !report ? (
          <div aria-label="Loading drift report" className="space-y-2">
            <div className="h-4 w-56 animate-pulse rounded bg-muted" />
            <div className="h-8 w-full animate-pulse rounded bg-muted" />
          </div>
        ) : error && !report ? (
          <div role="status">
            <p className="text-destructive">{error}</p>
            <button
              className="mt-2 rounded border border-border px-2 py-1"
              onClick={() => void loadReport()}
              type="button"
            >
              Retry report
            </button>
          </div>
        ) : refreshRequired ? (
          <div>
            <p className="text-muted-foreground">
              No drift report exists for this accepted findings version yet.
            </p>
            <button
              className="mt-2 rounded border border-border px-2 py-1"
              disabled={loading}
              onClick={() => void refresh()}
              type="button"
            >
              Refresh drift
            </button>
          </div>
        ) : report ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {Object.entries(report.totals).map(([state, count]) => (
                <span
                  className="rounded border border-border bg-muted/50 px-2 py-1"
                  key={state}
                >
                  {DRIFT_LABELS[state as keyof typeof DRIFT_LABELS]}{" "}
                  {count.toLocaleString()}
                </span>
              ))}
              <button
                className="rounded border border-border px-2 py-1"
                disabled={loading}
                onClick={() => void refresh()}
                type="button"
              >
                Refresh
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Run <span className="font-mono">{report.runId}</span> ·{" "}
              {report.createdAt} · {report.unclassifiedCount.toLocaleString()}{" "}
              unclassified
            </p>
            {report.items.length === 0 ? (
              <p className="text-muted-foreground">
                No local decisions currently drift from this version.
              </p>
            ) : (
              <ul
                className="max-h-44 space-y-1 overflow-auto"
                aria-label="Drift findings"
              >
                {report.items.map((item) => (
                  <li
                    className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 rounded bg-muted/40 px-2 py-1"
                    key={item.stableKey}
                  >
                    <span className="font-medium">
                      {DRIFT_LABELS[item.state]}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">
                        {item.stableKey}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {item.reason}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {report.nextCursor ? (
              <button
                className="rounded border border-border px-2 py-1"
                disabled={loadingMore}
                onClick={() => void loadReport(report.nextCursor)}
                type="button"
              >
                {loadingMore ? "Loading…" : "Load more drift"}
              </button>
            ) : null}
          </>
        ) : null}

        <div className="grid gap-2 border-t border-border pt-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-2">
            <p className="font-medium">Import vendor VEX</p>
            <input
              aria-label="Vendor name"
              className="w-full rounded border border-border bg-background px-2 py-1"
              onChange={(event) => setVendor(event.target.value)}
              placeholder="Vendor name"
              value={vendor}
            />
            <input
              accept="application/json,.json"
              aria-label="Vendor VEX file"
              className="w-full text-xs"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              type="file"
            />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                checked={overwrite}
                onChange={(event) => setOverwrite(event.target.checked)}
                type="checkbox"
              />
              Overwrite existing local decisions (human review only)
            </label>
            <div className="flex gap-2">
              <button
                className="rounded border border-border px-2 py-1"
                disabled={importing || !file || !vendor.trim()}
                onClick={() => void importVex(true)}
                type="button"
              >
                Preview import
              </button>
              <button
                className="rounded border border-border px-2 py-1"
                disabled={importing || !file || !vendor.trim()}
                onClick={() => void importVex(false)}
                type="button"
              >
                Import VEX
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <p className="font-medium">Orphan cleanup</p>
            <p className="text-xs text-muted-foreground">
              Pruning edits local YAML. Preview uses the loaded orphan keys and
              a fresh base-state digest.
            </p>
            {prunePreview ? (
              <div className="rounded border border-destructive/40 p-2">
                <p>
                  Remove {prunePreview.selected.toLocaleString()} proven
                  orphaned decisions?
                </p>
                <button
                  className="mt-2 rounded border border-destructive/60 px-2 py-1 text-destructive"
                  onClick={() => void confirmPrune()}
                  type="button"
                >
                  Confirm prune
                </button>
                <button
                  className="ml-2 rounded border border-border px-2 py-1"
                  onClick={() => setPrunePreview(null)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="rounded border border-border px-2 py-1"
                disabled={orphanKeys.length === 0}
                onClick={() => void previewPrune()}
                type="button"
              >
                Preview prune loaded orphans (
                {orphanKeys.length.toLocaleString()})
              </button>
            )}
          </div>
        </div>
        {error && report ? (
          <p className="text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {action ? (
          <p className="text-muted-foreground" role="status">
            {action}
          </p>
        ) : null}
      </div>
    </details>
  );
}
