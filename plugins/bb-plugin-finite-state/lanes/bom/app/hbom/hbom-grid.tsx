import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { useBbNavigate, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { JsonValue, rpcContract } from "../../../../shared/contract.js";
import { HbomCell } from "./hbom-cell.js";
import {
  COLUMN_GROUPS,
  parseCellState,
  parseSourceRef,
} from "./hbom-presentation.js";
import { HbomSummaryCard } from "./hbom-summary-card.js";
import {
  ProvenancePopover,
  type ProvenancePopoverState,
} from "./provenance-popover.js";
import type { HbomCellView } from "../../hbom/cell-view.js";

export interface HbomGridProps {
  projectId: string;
  projectVersionId: string | null;
  onOpenPart(partId: string): void;
}

interface PartRow {
  id: string;
  label: string;
  asComponentId: string | null;
  asMissing: boolean;
  verifiedRatio: number;
  conflictCount: number;
  cells: Record<string, HbomCellView>;
  hbomSha256: string;
}

type GridState =
  | { kind: "loading" }
  | { kind: "unconfigured"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      rows: PartRow[];
      queueDepth: number;
      verifiedRatio: number;
    };

function recordValue(
  value: JsonValue | undefined,
): Record<string, JsonValue> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function stringValue(
  fields: Record<string, JsonValue>,
  key: string,
): string | null {
  const value = fields[key];
  return typeof value === "string" ? value : null;
}

function numberValue(fields: Record<string, JsonValue>, key: string): number {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function booleanValue(fields: Record<string, JsonValue>, key: string): boolean {
  return fields[key] === true;
}

function GridSkeleton(): React.JSX.Element {
  return (
    <div
      aria-label="Loading hardware inventory"
      className="space-y-2 p-3"
      role="status"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div className="flex h-12 items-center gap-3" key={index}>
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

export function HbomGrid({
  projectId,
  projectVersionId,
  onOpenPart,
}: HbomGridProps): React.JSX.Element {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const parentRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [popover, setPopover] = useState<{
    partId: string;
    field: string;
    state: ProvenancePopoverState;
  } | null>(null);
  const [state, setState] = useState<GridState>(() =>
    projectId
      ? { kind: "loading" }
      : {
          kind: "unconfigured",
          message: "Choose a project to load the hardware inventory.",
        },
  );

  useRealtime("hbom:changed", (payload) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      "projectId" in payload &&
      payload.projectId === projectId
    ) {
      setRevision((value) => value + 1);
    }
  });

  useEffect(() => {
    if (!projectId) {
      setState({
        kind: "unconfigured",
        message: "Choose a project to load the hardware inventory.",
      });
      return;
    }
    let active = true;
    setState({ kind: "loading" });
    const input = {
      projectId,
      projectVersionId,
      pageSize: 200,
      continuation: null as string | null,
      filters: { view: "parts" },
    };
    void rpc
      .call("hbomReviewList", input)
      .then((page) => {
        if (!active) return;
        if (page.cache.state === "empty") {
          setState({
            kind: "empty",
            message:
              page.cache.message ??
              "No hbom.yaml yet. Seed from AS components or ingest a BOM.",
          });
          return;
        }
        const rows: PartRow[] = [];
        let queueDepth = 0;
        let verifiedRatio = 0;
        for (const item of page.items) {
          if (item.kind === "hbomSummary") {
            queueDepth = numberValue(item.fields, "queueDepth");
            verifiedRatio = numberValue(item.fields, "verifiedRatio");
            continue;
          }
          if (item.kind !== "hbomPart") continue;
          const cellsRaw = recordValue(item.fields.cells) ?? {};
          const cells: Record<string, HbomCellView> = {};
          for (const [field, raw] of Object.entries(cellsRaw)) {
            const cell = recordValue(raw);
            if (!cell) continue;
            const confidence = cell.confidence;
            cells[field] = {
              partId: item.key,
              field,
              value: cell.value,
              state: parseCellState(cell.state),
              confidence:
                typeof confidence === "number" && Number.isFinite(confidence)
                  ? confidence
                  : null,
              sourceRef: parseSourceRef(cell.sourceRef),
              acceptedBy: stringValue(cell, "acceptedBy"),
              acceptedAt: stringValue(cell, "acceptedAt"),
              candidateCount:
                typeof cell.candidateCount === "number"
                  ? cell.candidateCount
                  : 0,
            };
          }
          queueDepth = numberValue(item.fields, "queueDepth");
          verifiedRatio = numberValue(item.fields, "verifiedRatio");
          rows.push({
            id: item.key,
            label: item.label,
            asComponentId: stringValue(item.fields, "asComponentId"),
            asMissing: booleanValue(item.fields, "asMissing"),
            verifiedRatio: numberValue(item.fields, "completeness"),
            conflictCount: numberValue(item.fields, "conflictCount"),
            cells,
            hbomSha256: stringValue(item.fields, "hbomSha256") ?? "",
          });
        }
        if (rows.length === 0) {
          setState({
            kind: "empty",
            message:
              "HBOM has no parts yet. Seed from architecture components or ingest documents.",
          });
          return;
        }
        setState({ kind: "ready", rows, queueDepth, verifiedRatio });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setState({
          kind: "error",
          message:
            cause instanceof Error
              ? cause.message
              : "Hardware inventory could not be loaded.",
        });
      });
    return () => {
      active = false;
    };
  }, [projectId, projectVersionId, revision, rpc]);

  const rows = state.kind === "ready" ? state.rows : [];
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 8,
  });

  const visibleGroups = useMemo(
    () => COLUMN_GROUPS.filter((group) => !collapsed[group.id]),
    [collapsed],
  );

  if (state.kind === "loading") return <GridSkeleton />;
  if (state.kind === "unconfigured" || state.kind === "empty") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <Icon
            aria-hidden="true"
            className="mx-auto size-6 text-muted-foreground"
            name="PackageReceive"
          />
          <h2 className="mt-3 text-base font-semibold">
            {state.kind === "empty" ? "No hardware parts" : "HBOM unconfigured"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
          {state.kind === "empty" ? (
            <Button
              className="mt-4"
              onClick={() =>
                navigate.toPluginPanel("bom", { subPath: "hardware/ingest" })
              }
              size="sm"
              variant="outline"
            >
              Open ingest
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <h2 className="text-base font-semibold text-destructive">
            Hardware inventory unavailable
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
          <Button
            className="mt-4"
            onClick={() => setRevision((value) => value + 1)}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-3 py-2">
        <div className="min-w-56 flex-1">
          <HbomSummaryCard id={projectId} projectVersionId={projectVersionId} />
        </div>
        <div className="flex flex-wrap gap-2">
          {COLUMN_GROUPS.map((group) => (
            <Button
              key={group.id}
              onClick={() =>
                setCollapsed((current) => ({
                  ...current,
                  [group.id]: !current[group.id],
                }))
              }
              size="sm"
              variant={collapsed[group.id] ? "ghost" : "secondary"}
            >
              {group.label}
            </Button>
          ))}
          <Button
            onClick={() =>
              navigate.toPluginPanel("bom", { subPath: "hardware/review" })
            }
            size="sm"
            variant="outline"
          >
            Review queue ({state.queueDepth})
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" ref={parentRef}>
        <div
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]!;
            return (
              <div
                className="absolute left-0 top-0 flex w-full items-start gap-3 border-b border-border/70 px-3 py-2"
                data-index={virtualRow.index}
                key={row.id}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <button
                  className="w-40 shrink-0 text-left"
                  onClick={() => onOpenPart(row.id)}
                  type="button"
                >
                  <p className="font-mono text-xs text-muted-foreground">
                    {row.id}
                  </p>
                  <p className="text-sm font-medium">{row.label}</p>
                  <p className="text-[10px] text-muted-foreground">
                    AS {row.asComponentId ?? "unmodeled"}
                    {row.asMissing ? " · missing upstream" : ""}
                    {row.conflictCount > 0
                      ? ` · ${row.conflictCount} conflict`
                      : ""}
                  </p>
                </button>
                <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                  {visibleGroups.map((group) => (
                    <div className="min-w-40" key={group.id}>
                      <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {group.label}
                      </p>
                      <div className="space-y-1">
                        {group.fields.map((field) => {
                          const cell = row.cells[field];
                          if (!cell) {
                            return (
                              <p
                                className="px-1 font-mono text-xs text-muted-foreground"
                                key={field}
                              >
                                {field}: —
                              </p>
                            );
                          }
                          return (
                            <HbomCell
                              cell={cell}
                              compact
                              key={field}
                              onOpenProvenance={() =>
                                setPopover({
                                  partId: row.id,
                                  field,
                                  state: {
                                    kind: "ready",
                                    cell,
                                    provenance: null,
                                    extractor: null,
                                    extractedAt: null,
                                    note: null,
                                    competing: [],
                                    documentMissing: false,
                                    documentWithdrawn: false,
                                  },
                                })
                              }
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {popover ? (
        <div className="absolute bottom-4 right-4 z-10">
          <ProvenancePopover
            onClose={() => setPopover(null)}
            onReview={() =>
              navigate.toPluginPanel("bom", { subPath: "hardware/review" })
            }
            state={popover.state}
          />
        </div>
      ) : null}
    </div>
  );
}
