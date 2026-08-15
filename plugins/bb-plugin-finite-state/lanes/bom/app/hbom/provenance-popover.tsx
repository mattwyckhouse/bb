import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { useBbNavigate } from "@bb/plugin-sdk/app";
import type { DocumentSourceRef } from "../../../../shared/contract.js";
import {
  formatCellValue,
  formatLocator,
  sourceRefSubPath,
} from "./hbom-presentation.js";
import type { HbomCellView } from "../../hbom/cell-view.js";

export type ProvenancePopoverState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string; onRetry(): void }
  | { kind: "unconfigured"; message: string }
  | {
      kind: "ready";
      cell: HbomCellView;
      provenance: string | null;
      extractor: string | null;
      extractedAt: string | null;
      note: string | null;
      competing: Array<{
        value: unknown;
        provenance: string;
        confidence: number;
        sourceRef: DocumentSourceRef | null;
      }>;
      documentMissing: boolean;
      documentWithdrawn: boolean;
    };

export interface ProvenancePopoverProps {
  state: ProvenancePopoverState;
  onClose(): void;
  onReview?(): void;
}

function SourceLink({
  sourceRef,
  missing,
}: {
  sourceRef: DocumentSourceRef | null;
  missing: boolean;
}): React.JSX.Element {
  const navigate = useBbNavigate();
  if (sourceRef === null) {
    return (
      <p className="text-sm text-muted-foreground">
        No document citation on this cell.
      </p>
    );
  }
  if (missing) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Source document {sourceRef.documentSha256.slice(0, 12)}… is missing from
        the ledger. Re-upload the file to restore the citation, then reopen this
        cell.
      </p>
    );
  }
  const encoded = sourceRefSubPath(sourceRef);
  return (
    <Button
      onClick={() =>
        navigate.toPluginPanel("documents", {
          subPath: encoded,
        })
      }
      size="sm"
      variant="outline"
    >
      <Icon aria-hidden="true" className="size-4" name="FileText" />
      Open source · {formatLocator(sourceRef)}
    </Button>
  );
}

export function ProvenancePopover({
  state,
  onClose,
  onReview,
}: ProvenancePopoverProps): React.JSX.Element {
  if (state.kind === "loading") {
    return (
      <div
        aria-label="Loading provenance"
        className="w-80 space-y-2 rounded-md border border-border bg-card p-3 shadow-sm"
        role="status"
      >
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (state.kind === "empty") {
    return (
      <div className="w-80 rounded-md border border-border bg-card p-3 text-sm text-muted-foreground shadow-sm">
        No provenance story for this cell.
        <div className="mt-2">
          <Button onClick={onClose} size="sm" variant="ghost">
            Close
          </Button>
        </div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="w-80 rounded-md border border-border bg-card p-3 shadow-sm">
        <p className="text-sm text-destructive">{state.message}</p>
        <div className="mt-2 flex gap-2">
          <Button onClick={state.onRetry} size="sm" variant="outline">
            Retry
          </Button>
          <Button onClick={onClose} size="sm" variant="ghost">
            Close
          </Button>
        </div>
      </div>
    );
  }
  if (state.kind === "unconfigured") {
    return (
      <div className="w-80 rounded-md border border-border bg-card p-3 shadow-sm">
        <p className="text-sm text-muted-foreground">{state.message}</p>
        <Button className="mt-2" onClick={onClose} size="sm" variant="ghost">
          Close
        </Button>
      </div>
    );
  }

  const { cell } = state;
  const display = formatCellValue(cell.value, cell.state);
  return (
    <div
      aria-label={`Provenance for ${cell.field}`}
      className="w-96 max-w-[90vw] rounded-md border border-border bg-card p-3 text-card-foreground shadow-sm"
      role="dialog"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-muted-foreground">
            {cell.partId} · {cell.field}
          </p>
          <p className="mt-1 font-mono text-sm text-foreground">{display}</p>
        </div>
        <Button onClick={onClose} size="sm" variant="ghost">
          Close
        </Button>
      </div>
      <dl className="mt-3 space-y-1 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Provenance</dt>
          <dd className="font-mono">{state.provenance ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Confidence</dt>
          <dd className="font-mono">
            {cell.confidence === null ? "—" : cell.confidence.toFixed(2)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Extractor</dt>
          <dd className="font-mono">{state.extractor ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Extracted</dt>
          <dd className="font-mono">{state.extractedAt ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Accepted</dt>
          <dd className="font-mono">
            {cell.acceptedBy
              ? `${cell.acceptedBy} · ${cell.acceptedAt ?? "—"}`
              : "not accepted"}
          </dd>
        </div>
        {state.note ? (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Note</dt>
            <dd>{state.note}</dd>
          </div>
        ) : null}
        {state.documentWithdrawn ? (
          <p className="pt-1 text-muted-foreground" role="status">
            Source withdrawn — accepted values remain; unaccepted claims need
            review.
          </p>
        ) : null}
      </dl>
      <div className="mt-3">
        <SourceLink
          missing={state.documentMissing}
          sourceRef={cell.sourceRef}
        />
      </div>
      {state.competing.length > 0 ? (
        <div className="mt-3 border-t border-border pt-2">
          <p className="text-xs font-medium text-muted-foreground">
            Competing claims
          </p>
          <ul className="mt-1 space-y-1">
            {state.competing.map((claim, index) => (
              <li
                className="rounded border border-border/70 px-2 py-1 text-xs"
                key={`${claim.provenance}-${index}`}
              >
                <span className="font-mono">
                  {formatCellValue(claim.value, "proposal")}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  · {claim.provenance} · {claim.confidence.toFixed(2)}
                  {claim.sourceRef
                    ? ` · ${formatLocator(claim.sourceRef)}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {onReview ? (
        <Button className="mt-3 w-full" onClick={onReview} size="sm">
          Open in review queue
        </Button>
      ) : null}
    </div>
  );
}
