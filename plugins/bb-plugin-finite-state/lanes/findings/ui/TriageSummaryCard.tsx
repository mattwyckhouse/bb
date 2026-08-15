import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  useRpc,
} from "@bb/plugin-sdk/app";
import { Badge } from "@bb/shared-ui/badge";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import type { z } from "zod";
import type { findingsUiRpcContract } from "../rpc.js";

export interface TriageSummaryCardProps {
  /** Durable triage_runs.run_id written by WP-28 policy/vendor/drift flows. */
  id: string;
  /** Optional Platform project-version scope for the directive. */
  version?: string;
}

type Summary = z.output<
  (typeof findingsUiRpcContract)["triageSummaryGet"]["output"]
>;

type CardState =
  | { kind: "loading" }
  | { kind: "unconfigured"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; summary: Summary };

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;

const SOURCE_LABEL: Record<Summary["source"], string> = {
  manual: "Manual",
  policy: "Policy",
  vendor_import: "Vendor import",
  drift: "Drift",
};

export function TriageSummaryCard({
  id,
  version,
}: TriageSummaryCardProps): React.JSX.Element {
  const context = useBbContext();
  const sidebar = experimental_useSidebarThreads();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof findingsUiRpcContract>();
  const workspaceProjectId =
    context.projectId ??
    (sidebar.status === "ready" ? (sidebar.projects[0]?.id ?? null) : null);
  const validId = SAFE_RUN_ID.test(id);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<CardState>(() => {
    if (!workspaceProjectId) {
      return {
        kind: "unconfigured",
        message: "Select a bb project with an accepted findings cache.",
      };
    }
    if (!validId) {
      return {
        kind: "invalid",
        message: "The triage run identifier is invalid. No request was sent.",
      };
    }
    return { kind: "loading" };
  });

  const load = useCallback(async () => {
    if (!workspaceProjectId || !validId) return;
    setState({ kind: "loading" });
    try {
      const versions = await rpc.call("cachedProjectVersions", {
        projectId: workspaceProjectId,
      });
      const scopedVersion =
        version !== undefined
          ? versions.versions.find(
              (entry) => entry.projectVersionId === version,
            )
          : (versions.versions.find(
              (entry) =>
                entry.platformProjectId ===
                  versions.selectedPlatformProjectId &&
                entry.projectVersionId === versions.selectedProjectVersionId,
            ) ?? versions.versions[0]);
      if (!scopedVersion) {
        setState({
          kind: "unconfigured",
          message:
            "No accepted findings version is available for this project.",
        });
        return;
      }
      const summary = await rpc.call("triageSummaryGet", {
        projectId: scopedVersion.platformProjectId,
        projectVersionId: scopedVersion.projectVersionId,
        runId: id,
      });
      setState({ kind: "ready", summary });
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "The triage summary could not be loaded.";
      setState({
        kind: /NOT_FOUND/u.test(message) ? "empty" : "error",
        message,
      });
    }
  }, [id, rpc, validId, version, workspaceProjectId]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const holdbackPreview = useMemo(() => {
    if (state.kind !== "ready") return [];
    return state.summary.holdbacks.slice(0, 5);
  }, [state]);

  if (state.kind === "loading") {
    return (
      <div
        aria-label="Loading triage summary"
        className="space-y-2 rounded-lg border border-border bg-card p-4"
        role="status"
      >
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  if (
    state.kind === "unconfigured" ||
    state.kind === "invalid" ||
    state.kind === "empty"
  ) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <Icon
          aria-hidden="true"
          className="size-5 text-muted-foreground"
          name="FileQuestion"
        />
        <h3 className="mt-2 text-sm font-semibold">
          {state.kind === "unconfigured"
            ? "Triage summary unconfigured"
            : state.kind === "invalid"
              ? "Invalid triage run identity"
              : "Triage run not found"}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-destructive">
          Triage summary unavailable
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
        <Button
          className="mt-3"
          onClick={() => setRevision((value) => value + 1)}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </div>
    );
  }

  const { summary } = state;
  return (
    <section
      aria-label={`Triage summary ${summary.runId}`}
      className="rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Triage run
          </p>
          <p className="mt-1 truncate font-mono text-xs">{summary.runId}</p>
        </div>
        <Badge variant="outline">{SOURCE_LABEL[summary.source]}</Badge>
        <Badge
          variant={
            summary.status === "failed" || summary.status === "partial"
              ? "destructive"
              : "secondary"
          }
        >
          {summary.status}
        </Badge>
        {summary.dryRun ? <Badge variant="outline">Dry run</Badge> : null}
      </header>
      <p className="mt-3 text-sm">
        <span className="font-medium tabular-nums">{summary.written}</span>{" "}
        written ·{" "}
        <span className="font-medium tabular-nums">{summary.held}</span> held ·{" "}
        <span className="font-medium tabular-nums">{summary.conflicts}</span>{" "}
        conflicts ·{" "}
        <span className="font-medium tabular-nums">{summary.errors}</span>{" "}
        errors
      </p>
      {holdbackPreview.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {holdbackPreview.map((holdback) => (
            <li
              className="rounded-md border border-border bg-background/70 p-2 text-xs"
              key={`${holdback.stableKey}:${holdback.rule}`}
            >
              <p className="font-mono text-muted-foreground">
                {holdback.stableKey}
              </p>
              <p className="mt-1">
                <span className="font-medium">{holdback.rule}</span> —{" "}
                {holdback.why}
              </p>
            </li>
          ))}
          {summary.holdbacks.length > holdbackPreview.length ? (
            <li className="text-xs text-muted-foreground">
              +{summary.holdbacks.length - holdbackPreview.length} more
              holdbacks
            </li>
          ) : null}
        </ul>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          onClick={() =>
            navigate.toPluginPanel("findings", { subPath: "triage" })
          }
          size="sm"
          variant="secondary"
        >
          View diff
        </Button>
        <Button
          onClick={() => navigate.toPluginPanel("sync")}
          size="sm"
          variant="outline"
        >
          Open plan
        </Button>
      </div>
    </section>
  );
}
