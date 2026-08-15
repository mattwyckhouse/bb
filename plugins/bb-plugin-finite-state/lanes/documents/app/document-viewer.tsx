import { useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { Icon } from "@bb/shared-ui/icon";
import { Button } from "@bb/shared-ui/button";
import {
  type DocumentSourceRef,
  type RpcContract,
} from "../../../shared/contract.js";
import {
  ExtractionOverlay,
  type OverlayExtraction,
} from "./extraction-overlay.js";

export interface DocumentViewerProps {
  projectId: string;
  projectVersionId: string | null;
  documentId: string;
  sha256: string;
  name: string;
  mimeType: string;
  contentHref: string;
  sourceRef?: DocumentSourceRef | null;
}

export function DocumentViewer(props: DocumentViewerProps): React.JSX.Element {
  const rpc = useRpc<RpcContract>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [extractions, setExtractions] = useState<OverlayExtraction[]>([]);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        await rpc.call(
          "documentsGet",
          Object.assign(
            {
              projectId: props.projectId,
              projectVersionId: props.projectVersionId,
            },
            { documentId: props.documentId },
          ),
        );
        const page = await rpc.call(
          "documentsExtractionsList",
          Object.assign(
            {
              projectId: props.projectId,
              projectVersionId: props.projectVersionId,
              pageSize: 100,
              continuation: null,
            },
            { documentId: props.documentId },
          ),
        );
        if (cancelled) return;
        setExtractions(
          page.items.map((item) => ({
            id: item.key,
            field: item.label,
            value:
              typeof item.fields.value === "string" ? item.fields.value : "",
            confidence:
              typeof item.fields.confidence === "number"
                ? item.fields.confidence
                : null,
            status:
              typeof item.fields.status === "string"
                ? item.fields.status
                : "proposal",
            sourceRef:
              typeof item.fields.sourceRef === "string"
                ? item.fields.sourceRef
                : "",
            targetLabel:
              typeof item.fields.targetId === "string"
                ? `${String(item.fields.targetSurface ?? "target")}:${item.fields.targetId}${typeof item.fields.targetField === "string" ? `.${item.fields.targetField}` : ""}`
                : null,
            page:
              typeof item.fields.page === "number" ? item.fields.page : null,
            sheet:
              typeof item.fields.sheet === "string" ? item.fields.sheet : null,
            cell:
              typeof item.fields.cell === "string" ? item.fields.cell : null,
            bbox:
              typeof item.fields.bbox === "string" ? item.fields.bbox : null,
          })),
        );

        if (
          props.mimeType.startsWith("text/") ||
          props.mimeType === "application/xml" ||
          props.mimeType === "text/csv"
        ) {
          const response = await fetch(props.contentHref, {
            headers: { Range: "bytes=0-65535" },
          });
          if (response.status === 404) {
            const body: unknown = await response.json().catch(() => null);
            const code =
              typeof body === "object" &&
              body !== null &&
              typeof Reflect.get(Reflect.get(body, "error") ?? {}, "code") ===
                "string"
                ? String(Reflect.get(Reflect.get(body, "error") ?? {}, "code"))
                : "DOCUMENT_CONTENT_MISSING";
            throw new Error(
              `${code}: ledger blob missing — re-upload the same SHA-256 to heal.`,
            );
          }
          if (!response.ok) {
            throw new Error(`Preview failed (${response.status})`);
          }
          setPreviewText(await response.text());
        } else {
          setPreviewText(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Document viewer failed to load.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    props.contentHref,
    props.documentId,
    props.mimeType,
    props.projectId,
    props.projectVersionId,
    revision,
    rpc,
  ]);

  if (loading) {
    return (
      <div
        aria-label="Loading document viewer"
        className="space-y-3 p-4"
        role="status"
      >
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <Icon
            className="mx-auto size-6 text-destructive"
            name="AlertCircle"
          />
          <h2 className="mt-3 text-base font-semibold">Viewer error</h2>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Button
            className="mt-4"
            onClick={() => setRevision((value) => value + 1)}
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const focusPage =
    props.sourceRef?.locator.kind === "pdf"
      ? props.sourceRef.locator.page
      : (extractions.find((item) => item.page !== null)?.page ?? 1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-4 py-3">
        <h2 className="truncate text-sm font-semibold">{props.name}</h2>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {props.sha256} · {props.mimeType} · plugin-local
        </p>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_20rem]">
        <div className="relative min-h-0 overflow-auto bg-muted/20 p-3">
          {props.mimeType === "application/pdf" ? (
            <iframe
              className="h-full min-h-[28rem] w-full rounded-md border border-border bg-background"
              sandbox=""
              src={`${props.contentHref}#page=${focusPage}`}
              title={`${props.name} preview`}
            />
          ) : previewText !== null ? (
            <pre className="overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
              {previewText}
            </pre>
          ) : (
            <div className="rounded-md border border-border bg-background p-4 text-sm text-muted-foreground">
              Binary workbook/register-map preview is bounded. Use the
              authenticated content route or open the tracked worktree path.
              <div className="mt-3">
                <a
                  className="text-sm font-medium underline"
                  href={props.contentHref}
                  rel="noreferrer"
                >
                  Open authenticated content
                </a>
              </div>
            </div>
          )}
          <ExtractionOverlay
            extractions={extractions}
            focus={props.sourceRef ?? null}
          />
        </div>
        <aside className="min-h-0 overflow-auto border-l border-border p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Extractions
          </h3>
          {extractions.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No recorded extractions yet. Overlay coordinates only appear when
              a proposal stores them.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {extractions.map((item) => (
                <li
                  className="rounded-md border border-border bg-card p-2 text-sm"
                  key={item.id}
                >
                  <div className="font-medium">{item.field}</div>
                  <div className="mt-1 break-words text-muted-foreground">
                    {item.value || "—"}
                  </div>
                  <div className="mt-2 font-mono text-[11px] text-muted-foreground">
                    {item.sourceRef}
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {item.status}
                    {item.confidence !== null
                      ? ` · confidence ${item.confidence.toFixed(2)}`
                      : ""}
                    {item.targetLabel ? ` · ${item.targetLabel}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
