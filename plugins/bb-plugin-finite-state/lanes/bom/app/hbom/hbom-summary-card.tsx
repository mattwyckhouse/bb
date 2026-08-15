import { useEffect, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import type { JsonValue, rpcContract } from "../../../../shared/contract.js";

export interface HbomSummaryCardProps {
  /** Workspace / platform project id used for the HBOM scope. */
  id: string;
  projectVersionId?: string | null;
}

type CardState =
  | { kind: "loading" }
  | { kind: "unconfigured"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      partCount: number;
      verifiedRatio: number;
      queueDepth: number;
      cellCount: number;
    };

function numberField(fields: Record<string, JsonValue>, key: string): number {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function HbomSummaryCard({
  id,
  projectVersionId = null,
}: HbomSummaryCardProps): React.JSX.Element {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<CardState>(() =>
    id.trim().length === 0
      ? {
          kind: "unconfigured",
          message: "Provide a project id to load HBOM trust metrics.",
        }
      : { kind: "loading" },
  );

  useEffect(() => {
    const projectId = id.trim();
    if (projectId.length === 0) {
      setState({
        kind: "unconfigured",
        message: "Provide a project id to load HBOM trust metrics.",
      });
      return;
    }
    let active = true;
    setState({ kind: "loading" });
    const input = {
      projectId,
      projectVersionId,
      pageSize: 1,
      continuation: null as string | null,
      filters: { view: "summary" },
    };
    void rpc
      .call("hbomReviewList", input)
      .then((page) => {
        if (!active) return;
        const item = page.items[0];
        if (!item || page.cache.state === "empty") {
          setState({
            kind: "empty",
            message:
              page.cache.message ??
              "No HBOM yet. Seed from architecture or ingest a BOM document.",
          });
          return;
        }
        setState({
          kind: "ready",
          partCount: numberField(item.fields, "partCount"),
          verifiedRatio: numberField(item.fields, "verifiedRatio"),
          queueDepth: numberField(item.fields, "queueDepth"),
          cellCount: numberField(item.fields, "cellCount"),
        });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setState({
          kind: "error",
          message:
            cause instanceof Error
              ? cause.message
              : "HBOM summary could not be loaded.",
        });
      });
    return () => {
      active = false;
    };
  }, [id, projectVersionId, revision, rpc]);

  if (state.kind === "loading") {
    return (
      <div
        aria-label="Loading HBOM summary"
        className="space-y-2 rounded-lg border border-border bg-card p-4"
        role="status"
      >
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  if (state.kind === "unconfigured" || state.kind === "empty") {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <Icon
          aria-hidden="true"
          className="size-5 text-muted-foreground"
          name="PackageReceive"
        />
        <h3 className="mt-2 text-sm font-semibold">
          {state.kind === "unconfigured" ? "HBOM unconfigured" : "HBOM empty"}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-destructive">
          HBOM summary unavailable
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

  const verifiedPercent = Math.round(state.verifiedRatio * 100);
  return (
    <div className="rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs">
      <h3 className="text-sm font-semibold">HBOM trust</h3>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs text-muted-foreground">Human-verified</dt>
          <dd className="font-mono text-2xl tabular-nums">
            {verifiedPercent}%
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Review queue</dt>
          <dd className="font-mono text-2xl tabular-nums">
            {state.queueDepth}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Parts</dt>
          <dd className="font-mono text-sm tabular-nums">{state.partCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Cells</dt>
          <dd className="font-mono text-sm tabular-nums">{state.cellCount}</dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          onClick={() => navigate.toPluginPanel("bom", { subPath: "hardware" })}
          size="sm"
          variant="secondary"
        >
          Open HBOM
        </Button>
        <Button
          onClick={() =>
            navigate.toPluginPanel("bom", { subPath: "hardware/review" })
          }
          size="sm"
          variant="outline"
        >
          Open review queue
        </Button>
      </div>
    </div>
  );
}
