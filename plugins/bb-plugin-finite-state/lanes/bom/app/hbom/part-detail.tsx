import { useEffect, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import type {
  DocumentSourceRef,
  JsonValue,
  rpcContract,
} from "../../../../shared/contract.js";
import { HbomCell } from "./hbom-cell.js";
import { parseCellState, parseSourceRef } from "./hbom-presentation.js";
import {
  ProvenancePopover,
  type ProvenancePopoverState,
} from "./provenance-popover.js";
import type { HbomCellView } from "../../hbom/cell-view.js";
import { HBOM_PART_FIELDS } from "../../hbom/types.js";

export interface PartDetailProps {
  id: string;
  projectId: string;
  projectVersionId: string | null;
  onClose?(): void;
}

type DetailState =
  | { kind: "loading" }
  | { kind: "unconfigured"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      label: string;
      asComponentId: string | null;
      cells: HbomCellView[];
      externalRefs: Array<{ type: string; url: string }>;
      firmwareLink: string | null;
      extractorByField: Record<
        string,
        {
          provenance: string | null;
          by: string | null;
          at: string | null;
          note: string | null;
        }
      >;
      competingByField: Record<
        string,
        Array<{
          value: unknown;
          provenance: string;
          confidence: number;
          sourceRef: DocumentSourceRef | null;
        }>
      >;
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

export function PartDetail({
  id,
  projectId,
  projectVersionId,
  onClose,
}: PartDetailProps): React.JSX.Element {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [popover, setPopover] = useState<ProvenancePopoverState | null>(null);

  useEffect(() => {
    if (!projectId) {
      setState({
        kind: "unconfigured",
        message: "Choose a project to load this hardware part.",
      });
      return;
    }
    let active = true;
    setState({ kind: "loading" });
    void rpc
      .call("bomComponentGet", {
        projectId,
        projectVersionId,
        componentId: id,
        mode: "hardware",
      })
      .then((detail) => {
        if (!active) return;
        const cellsField = recordValue(detail.fields.cells) ?? {};
        const cells: HbomCellView[] = [];
        const extractorByField: Record<
          string,
          {
            provenance: string | null;
            by: string | null;
            at: string | null;
            note: string | null;
          }
        > = {};
        const competingByField: Record<
          string,
          Array<{
            value: unknown;
            provenance: string;
            confidence: number;
            sourceRef: DocumentSourceRef | null;
          }>
        > = {};
        for (const field of HBOM_PART_FIELDS) {
          const cell = recordValue(cellsField[field]);
          if (!cell) continue;
          const confidence = cell.confidence;
          cells.push({
            partId: id,
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
              typeof cell.candidateCount === "number" ? cell.candidateCount : 0,
          });
          extractorByField[field] = {
            provenance: stringValue(cell, "provenance"),
            by: stringValue(cell, "by"),
            at: stringValue(cell, "at"),
            note: stringValue(cell, "note"),
          };
        }
        const candidates = Array.isArray(detail.fields.candidates)
          ? detail.fields.candidates
          : [];
        for (const raw of candidates) {
          const candidate = recordValue(raw);
          if (!candidate) continue;
          const field = stringValue(candidate, "field");
          const provenance = stringValue(candidate, "provenance");
          const confidence = candidate.confidence;
          if (!field || !provenance || typeof confidence !== "number") continue;
          const list = competingByField[field] ?? [];
          list.push({
            value: candidate.value,
            provenance,
            confidence,
            sourceRef: parseSourceRef(candidate.sourceRef),
          });
          competingByField[field] = list;
        }
        const externalRefs = Array.isArray(detail.fields.externalRefs)
          ? detail.fields.externalRefs.flatMap((raw) => {
              const ref = recordValue(raw);
              const type = ref ? stringValue(ref, "type") : null;
              const url = ref ? stringValue(ref, "url") : null;
              return type && url ? [{ type, url }] : [];
            })
          : [];
        setState({
          kind: "ready",
          label: detail.label,
          asComponentId: stringValue(detail.fields, "asComponentId"),
          cells,
          externalRefs,
          firmwareLink: stringValue(detail.fields, "firmwareLink"),
          extractorByField,
          competingByField,
        });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const message =
          cause instanceof Error ? cause.message : "Part detail failed.";
        if (/NOT_FOUND/u.test(message)) {
          setState({
            kind: "empty",
            message: `Part ${id} is not in hbom.yaml.`,
          });
          return;
        }
        setState({ kind: "error", message });
      });
    return () => {
      active = false;
    };
  }, [id, projectId, projectVersionId, revision, rpc]);

  if (state.kind === "loading") {
    return (
      <div
        aria-label="Loading part detail"
        className="space-y-2 p-4"
        role="status"
      >
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  if (state.kind === "unconfigured" || state.kind === "empty") {
    return (
      <div className="p-4">
        <h2 className="text-base font-semibold">
          {state.kind === "empty" ? "Part not found" : "Part unavailable"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
        {onClose ? (
          <Button
            className="mt-3"
            onClick={onClose}
            size="sm"
            variant="outline"
          >
            Close
          </Button>
        ) : null}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="p-4">
        <h2 className="text-base font-semibold text-destructive">
          Part detail failed
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto border-l border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-muted-foreground">{id}</p>
          <h2 className="text-base font-semibold">{state.label}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            AS component:{" "}
            <span className="font-mono">
              {state.asComponentId ?? "unmodeled"}
            </span>
          </p>
        </div>
        {onClose ? (
          <Button onClick={onClose} size="sm" variant="ghost">
            Close
          </Button>
        ) : null}
      </div>
      <div className="mt-4 space-y-2">
        {state.cells.map((cell) => (
          <div
            className="flex items-start justify-between gap-2 border-b border-border/60 py-2"
            key={cell.field}
          >
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {cell.field}
              </p>
              <HbomCell
                cell={cell}
                onOpenProvenance={() => {
                  const meta = state.extractorByField[cell.field];
                  setPopover({
                    kind: "ready",
                    cell,
                    provenance: meta?.provenance ?? null,
                    extractor: meta?.by ?? null,
                    extractedAt: meta?.at ?? null,
                    note: meta?.note ?? null,
                    competing: state.competingByField[cell.field] ?? [],
                    documentMissing: false,
                    documentWithdrawn: false,
                  });
                }}
              />
            </div>
          </div>
        ))}
      </div>
      {state.firmwareLink ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Firmware / SBOM link:{" "}
          <span className="font-mono text-foreground">
            {state.firmwareLink}
          </span>
        </p>
      ) : null}
      {state.externalRefs.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs">
          {state.externalRefs.map((ref) => (
            <li key={`${ref.type}:${ref.url}`}>
              <span className="text-muted-foreground">{ref.type}: </span>
              <span className="font-mono">{ref.url}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        className="mt-4"
        onClick={() =>
          navigate.toPluginPanel("bom", { subPath: "hardware/review" })
        }
        size="sm"
        variant="outline"
      >
        Open review queue
      </Button>
      {popover ? (
        <div className="sticky bottom-2 mt-4">
          <ProvenancePopover
            onClose={() => setPopover(null)}
            onReview={() =>
              navigate.toPluginPanel("bom", { subPath: "hardware/review" })
            }
            state={popover}
          />
        </div>
      ) : null}
    </div>
  );
}
