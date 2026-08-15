import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { useBbNavigate, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type {
  DocumentSourceRef,
  JsonValue,
  rpcContract,
} from "../../../../shared/contract.js";
import {
  FRONTEND_CAPABILITY_PLACEHOLDER,
  formatCellValue,
  formatLocator,
  isFormControlTarget,
  parseCellState,
  parseSourceRef,
  sourceRefSubPath,
} from "./hbom-presentation.js";
import type { HbomCellView } from "../../hbom/cell-view.js";

interface QueueRow {
  id: string;
  partId: string;
  field: string;
  cell: HbomCellView;
  reason: string;
  provenance: string | null;
  hbomSha256: string;
  candidates: Array<{
    index: number;
    value: unknown;
    provenance: string;
    confidence: number;
    sourceRef: DocumentSourceRef | null;
  }>;
}

type QueueState =
  | { kind: "loading" }
  | { kind: "unconfigured"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; rows: QueueRow[] };

interface Filters {
  document: string;
  field: string;
  provenance: string;
  reason: string;
  minConfidence: string;
}

const EMPTY_FILTERS: Filters = {
  document: "",
  field: "",
  provenance: "",
  reason: "",
  minConfidence: "",
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

export interface ReviewQueueProps {
  projectId: string;
  projectVersionId: string | null;
}

export function ReviewQueue({
  projectId,
  projectVersionId,
}: ReviewQueueProps): React.JSX.Element {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const parentRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState(0);
  const [selectedCandidate, setSelectedCandidate] = useState(0);
  const [predicateIds, setPredicateIds] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState<"accept" | "reject" | null>(
    null,
  );
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const [staleDraft, setStaleDraft] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [state, setState] = useState<QueueState>(() =>
    projectId
      ? { kind: "loading" }
      : {
          kind: "unconfigured",
          message: "Choose a project to open the HBOM review queue.",
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
        message: "Choose a project to open the HBOM review queue.",
      });
      return;
    }
    let active = true;
    setState({ kind: "loading" });
    const rpcFilters: Record<string, JsonValue> = {};
    if (filters.document) rpcFilters.document = filters.document;
    if (filters.field) rpcFilters.field = filters.field;
    if (filters.provenance) rpcFilters.provenance = filters.provenance;
    if (filters.reason) rpcFilters.reason = filters.reason;
    if (filters.minConfidence) {
      const value = Number(filters.minConfidence);
      if (Number.isFinite(value)) rpcFilters.minConfidence = value;
    }
    const input = {
      projectId,
      projectVersionId,
      pageSize: 200,
      continuation: null as string | null,
      filters: rpcFilters,
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
              "No HBOM file yet. Ingest documents before reviewing.",
          });
          return;
        }
        const rows: QueueRow[] = page.items.map((item) => {
          const confidence = item.fields.confidence;
          const candidatesRaw = Array.isArray(item.fields.candidates)
            ? item.fields.candidates
            : [];
          const candidates = candidatesRaw.flatMap((raw, index) => {
            const candidate = recordValue(raw);
            if (!candidate) return [];
            const provenance = stringValue(candidate, "provenance");
            const conf = candidate.confidence;
            if (!provenance || typeof conf !== "number") return [];
            return [
              {
                index:
                  typeof candidate.index === "number" ? candidate.index : index,
                value: candidate.value,
                provenance,
                confidence: conf,
                sourceRef: parseSourceRef(candidate.sourceRef),
              },
            ];
          });
          const partId = stringValue(item.fields, "partId") ?? "unknown";
          const field = stringValue(item.fields, "field") ?? "unknown";
          const cell: HbomCellView = {
            partId,
            field,
            value: item.fields.value,
            state: parseCellState(item.fields.state),
            confidence:
              typeof confidence === "number" && Number.isFinite(confidence)
                ? confidence
                : null,
            sourceRef: parseSourceRef(item.fields.sourceRef),
            acceptedBy: stringValue(item.fields, "acceptedBy"),
            acceptedAt: stringValue(item.fields, "acceptedAt"),
            candidateCount: candidates.length,
          };
          return {
            id: item.key,
            partId,
            field,
            cell,
            reason: stringValue(item.fields, "reason") ?? "proposal",
            provenance: stringValue(item.fields, "provenance"),
            hbomSha256: stringValue(item.fields, "hbomSha256") ?? "",
            candidates,
          };
        });
        if (rows.length === 0) {
          setState({
            kind: "empty",
            message:
              "No review items match these filters. Clear filters or wait for new extractions.",
          });
          return;
        }
        setState({ kind: "ready", rows });
        setSelected((current) =>
          current >= rows.length ? Math.max(0, rows.length - 1) : current,
        );
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setState({
          kind: "error",
          message:
            cause instanceof Error
              ? cause.message
              : "Review queue could not be loaded.",
        });
      });
    return () => {
      active = false;
    };
  }, [filters, projectId, projectVersionId, revision, rpc]);

  const rows = useMemo(
    () => (state.kind === "ready" ? state.rows : []),
    [state],
  );
  const activeRow = rows[selected] ?? null;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 88,
    overscan: 6,
  });

  const blastRadius = useMemo(() => {
    const selectedRows = rows.filter((row) => predicateIds.has(row.id));
    const confidences = selectedRows
      .map((row) => row.cell.confidence)
      .filter((value): value is number => value !== null);
    const documents = new Set(
      selectedRows
        .map((row) => row.cell.sourceRef?.documentSha256.slice(0, 12))
        .filter((value): value is string => Boolean(value)),
    );
    return {
      count: selectedRows.length,
      minConfidence: confidences.length === 0 ? null : Math.min(...confidences),
      documents: [...documents],
    };
  }, [predicateIds, rows]);

  async function submitDecisions(
    decisions: Array<
      | { id: string; action: "accept"; candidateIndex?: number }
      | { id: string; action: "reject"; candidateIndex?: number }
      | { id: string; action: "edit"; value: JsonValue; note?: string }
    >,
    expectedHbomSha256: string,
  ): Promise<void> {
    // Capability string is required by the frozen schema but is never evidence
    // of approval; the server fails closed regardless of this value.
    const capability = FRONTEND_CAPABILITY_PLACEHOLDER;
    try {
      await rpc.call("hbomReviewResolve", {
        projectId,
        projectVersionId,
        humanApprovalCapability: capability,
        expectedHbomSha256,
        decisions,
      });
      setActionMessage(null);
      setEditDraft(null);
      setStaleDraft(null);
      setRevision((value) => value + 1);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "Review action failed.";
      if (/HBOM_STALE|authorization-unavailable/u.test(message)) {
        if (editDraft !== null) setStaleDraft(editDraft);
        setActionMessage(
          /HBOM_STALE/u.test(message)
            ? "HBOM changed concurrently. Your draft was preserved — reload the queue and reapply manually."
            : "Human review is authorization-unavailable in v1. Draft preserved; no YAML write occurred.",
        );
        setRevision((value) => value + 1);
        return;
      }
      setActionMessage(message);
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (state.kind !== "ready" || rows.length === 0) return;
      if (isFormControlTarget(event.target)) return;
      const row = rows[selected];
      if (!row) return;
      if (event.key === "j") {
        event.preventDefault();
        setSelected((value) => Math.min(rows.length - 1, value + 1));
        setSelectedCandidate(0);
        return;
      }
      if (event.key === "k") {
        event.preventDefault();
        setSelected((value) => Math.max(0, value - 1));
        setSelectedCandidate(0);
        return;
      }
      if (event.key === "Enter" && row.cell.sourceRef) {
        event.preventDefault();
        const ref = row.cell.sourceRef;
        navigate.toPluginPanel("documents", {
          subPath: sourceRefSubPath(ref),
        });
        return;
      }
      if (event.key === "a") {
        event.preventDefault();
        void submitDecisions(
          [
            {
              id: row.id,
              action: "accept",
              ...(selectedCandidate > 0 || row.candidates.length > 0
                ? {
                    candidateIndex:
                      row.candidates[selectedCandidate]?.index ??
                      selectedCandidate,
                  }
                : {}),
            },
          ],
          row.hbomSha256,
        );
        return;
      }
      if (event.key === "r") {
        event.preventDefault();
        void submitDecisions(
          [{ id: row.id, action: "reject" }],
          row.hbomSha256,
        );
        return;
      }
      if (event.key === "e") {
        event.preventDefault();
        setEditDraft(
          staleDraft ??
            (typeof row.cell.value === "string"
              ? row.cell.value
              : formatCellValue(row.cell.value, row.cell.state)),
        );
        return;
      }
      if (/^[1-9]$/u.test(event.key)) {
        const index = Number(event.key) - 1;
        if (row.candidates[index]) {
          event.preventDefault();
          setSelectedCandidate(index);
          void submitDecisions(
            [
              {
                id: row.id,
                action: "accept",
                candidateIndex: row.candidates[index]!.index,
              },
            ],
            row.hbomSha256,
          );
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (state.kind === "loading") {
    return (
      <div
        aria-label="Loading review queue"
        className="space-y-2 p-3"
        role="status"
      >
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton className="h-16 w-full" key={index} />
        ))}
      </div>
    );
  }
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
            {state.kind === "empty"
              ? "Review queue clear"
              : "Review unconfigured"}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
          {state.kind === "empty" &&
          (filters.document ||
            filters.field ||
            filters.provenance ||
            filters.reason ||
            filters.minConfidence) ? (
            <Button
              className="mt-4"
              onClick={() => setFilters(EMPTY_FILTERS)}
              size="sm"
              variant="outline"
            >
              Clear filters
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
            Review queue unavailable
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
      <div className="flex flex-wrap items-end gap-2 border-b border-border bg-card px-3 py-2">
        {(
          [
            ["document", "Document SHA"],
            ["field", "Field"],
            ["provenance", "Provenance"],
            ["reason", "Reason"],
            ["minConfidence", "Min confidence"],
          ] as const
        ).map(([key, label]) => (
          <label className="text-xs text-muted-foreground" key={key}>
            {label}
            <input
              className="mt-1 block h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  [key]: event.target.value,
                }))
              }
              value={filters[key]}
            />
          </label>
        ))}
        <Button
          onClick={() => setPredicateIds(new Set(rows.map((row) => row.id)))}
          size="sm"
          variant="secondary"
        >
          Select matching ({rows.length})
        </Button>
        <Button
          disabled={predicateIds.size === 0}
          onClick={() => setConfirmBulk("accept")}
          size="sm"
        >
          Bulk accept
        </Button>
        <Button
          disabled={predicateIds.size === 0}
          onClick={() => setConfirmBulk("reject")}
          size="sm"
          variant="outline"
        >
          Bulk reject
        </Button>
      </div>
      {actionMessage ? (
        <p
          className="border-b border-border bg-muted/40 px-3 py-2 text-sm"
          role="status"
        >
          {actionMessage}
          {staleDraft !== null ? (
            <span className="ml-2 font-mono text-xs">Draft: {staleDraft}</span>
          ) : null}
        </p>
      ) : null}
      {confirmBulk ? (
        <div
          className="border-b border-border bg-card px-3 py-3"
          role="alertdialog"
        >
          <p className="text-sm">
            {confirmBulk === "accept" ? "Accept" : "Reject"} {blastRadius.count}{" "}
            cells
            {blastRadius.documents.length > 0
              ? ` from ${blastRadius.documents.join(", ")}…`
              : ""}
            {blastRadius.minConfidence !== null
              ? ` (min confidence ${blastRadius.minConfidence.toFixed(2)})`
              : ""}
            ?
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() => {
                const expected = rows[0]?.hbomSha256 ?? "";
                void submitDecisions(
                  rows
                    .filter((row) => predicateIds.has(row.id))
                    .map((row) => ({
                      id: row.id,
                      action: confirmBulk,
                    })),
                  expected,
                );
                setConfirmBulk(null);
                setPredicateIds(new Set());
              }}
              size="sm"
            >
              Confirm {confirmBulk}
            </Button>
            <Button
              onClick={() => setConfirmBulk(null)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {editDraft !== null && activeRow ? (
        <div className="border-b border-border bg-card px-3 py-3">
          <label className="text-xs text-muted-foreground">
            Human edit for {activeRow.partId} · {activeRow.field}
            <input
              autoFocus
              className="mt-1 block h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-sm"
              onChange={(event) => setEditDraft(event.target.value)}
              value={editDraft}
            />
          </label>
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() => {
                void submitDecisions(
                  [
                    {
                      id: activeRow.id,
                      action: "edit",
                      value: editDraft,
                    },
                  ],
                  activeRow.hbomSha256,
                );
              }}
              size="sm"
            >
              Save human value
            </Button>
            <Button
              onClick={() => setEditDraft(null)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto" ref={parentRef}>
        <div
          className="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index]!;
            const selectedRow = virtualRow.index === selected;
            return (
              <div
                aria-selected={selectedRow}
                className={`absolute left-0 top-0 grid w-full grid-cols-12 gap-3 border-b border-border/70 px-3 py-3 ${
                  selectedRow ? "bg-muted/40" : "bg-background"
                }`}
                data-index={virtualRow.index}
                key={row.id}
                onClick={() => {
                  setSelected(virtualRow.index);
                  setSelectedCandidate(0);
                }}
                ref={virtualizer.measureElement}
                role="row"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <div className="col-span-1">
                  <input
                    aria-label={`Select ${row.id}`}
                    checked={predicateIds.has(row.id)}
                    onChange={(event) => {
                      setPredicateIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(row.id);
                        else next.delete(row.id);
                        return next;
                      });
                    }}
                    type="checkbox"
                  />
                </div>
                <div className="col-span-3">
                  <p className="font-mono text-xs text-muted-foreground">
                    {row.partId} · {row.field}
                  </p>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {row.reason.replaceAll("_", " ")}
                  </p>
                  <p className="font-mono text-sm">
                    {formatCellValue(row.cell.value, row.cell.state)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {row.provenance ?? "unknown provenance"}
                    {row.cell.confidence !== null
                      ? ` · ${row.cell.confidence.toFixed(2)}`
                      : ""}
                  </p>
                </div>
                <div className="col-span-4 space-y-1">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Candidates
                  </p>
                  {row.candidates.length === 0 ? (
                    <p className="text-xs text-muted-foreground">None</p>
                  ) : (
                    row.candidates.map((candidate, index) => (
                      <button
                        className={`block w-full rounded border px-2 py-1 text-left text-xs ${
                          selectedRow && selectedCandidate === index
                            ? "border-ring bg-muted"
                            : "border-border"
                        }`}
                        key={`${row.id}-${candidate.index}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelected(virtualRow.index);
                          setSelectedCandidate(index);
                        }}
                        type="button"
                      >
                        <span className="font-mono">
                          {index + 1}.{" "}
                          {formatCellValue(candidate.value, "proposal")}
                        </span>
                        <span className="text-muted-foreground">
                          {" "}
                          · {candidate.provenance} ·{" "}
                          {candidate.confidence.toFixed(2)}
                          {candidate.sourceRef
                            ? ` · ${formatLocator(candidate.sourceRef)}`
                            : ""}
                        </span>
                      </button>
                    ))
                  )}
                </div>
                <div className="col-span-4 text-xs text-muted-foreground">
                  {row.cell.sourceRef ? (
                    <p>
                      Source {formatLocator(row.cell.sourceRef)} ·{" "}
                      <span className="font-mono">
                        {row.cell.sourceRef.documentSha256.slice(0, 12)}…
                      </span>
                    </p>
                  ) : (
                    <p>No source excerpt yet — open the document when cited.</p>
                  )}
                  <p className="mt-2">
                    Shortcuts: j/k · Enter source · a accept · 1-9 candidate · e
                    edit · r reject
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
