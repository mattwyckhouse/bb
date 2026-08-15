import { useCallback, useEffect, useState } from "react";
import { useBbContext, useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import { Badge } from "@bb/shared-ui/badge";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import type { JsonValue, rpcContract } from "../../../shared/contract.js";

export interface DocumentCardProps {
  /** Document id (SHA-256 at upload time). */
  id: string;
  projectVersionId?: string | null;
}

const SHA256 = /^[a-f0-9]{64}$/u;

type CardState =
  | { kind: "loading" }
  | { kind: "unconfigured"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      documentId: string;
      name: string;
      sha256: string;
      mimeType: string;
      docKind: string | null;
      bytes: number | null;
      withdrawn: boolean;
      contentHref: string;
    };

function stringField(
  fields: Record<string, JsonValue>,
  key: string,
): string | null {
  const value = fields[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(
  fields: Record<string, JsonValue>,
  key: string,
): number | null {
  const value = fields[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField(fields: Record<string, JsonValue>, key: string): boolean {
  return fields[key] === true;
}

/** AMD-0026 R2: digest is a query parameter, never a path segment. */
export function documentContentHref(
  projectId: string,
  projectVersionId: string | null,
  sha256: string,
): string {
  const version =
    projectVersionId === null ? "" : encodeURIComponent(projectVersionId);
  return `/api/v1/plugins/finite-state/http/documents/content?sha256=${encodeURIComponent(sha256)}&projectId=${encodeURIComponent(projectId)}&projectVersionId=${version}`;
}

export function DocumentCard({
  id,
  projectVersionId = null,
}: DocumentCardProps): React.JSX.Element {
  const { projectId } = useBbContext();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<CardState>(() => {
    if (!projectId) {
      return {
        kind: "unconfigured",
        message: "Select the bb project that owns this document.",
      };
    }
    if (!SHA256.test(id)) {
      return {
        kind: "invalid",
        message: "The document identifier must be a lowercase sha256 digest.",
      };
    }
    return { kind: "loading" };
  });

  const load = useCallback(async () => {
    if (!projectId || !SHA256.test(id)) return;
    setState({ kind: "loading" });
    try {
      const result = await rpc.call("documentsGet", {
        projectId,
        projectVersionId,
        documentId: id,
      });
      const sha256 = stringField(result.fields, "sha256") ?? result.key;
      setState({
        kind: "ready",
        documentId: result.key,
        name: result.label,
        sha256,
        mimeType:
          stringField(result.fields, "mimeType") ?? "application/octet-stream",
        docKind: stringField(result.fields, "docKind"),
        bytes: numberField(result.fields, "bytes"),
        withdrawn: booleanField(result.fields, "withdrawn"),
        contentHref: documentContentHref(projectId, projectVersionId, sha256),
      });
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "The document could not be loaded.";
      setState({
        kind: /NOT_FOUND/u.test(message) ? "empty" : "error",
        message,
      });
    }
  }, [id, projectId, projectVersionId, rpc]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  if (state.kind === "loading") {
    return (
      <div
        aria-label="Loading document card"
        className="space-y-2 rounded-lg border border-border bg-card p-4"
        role="status"
      >
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-1/2" />
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
            ? "Document unconfigured"
            : state.kind === "invalid"
              ? "Invalid document identity"
              : "Document not found"}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-destructive">
          Document unavailable
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

  return (
    <section
      aria-label={`Document ${state.name}`}
      className="rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Document
          </p>
          <h3 className="mt-1 truncate text-sm font-semibold">{state.name}</h3>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {state.sha256}
          </p>
        </div>
        {state.docKind ? (
          <Badge variant="outline">{state.docKind}</Badge>
        ) : null}
        {state.withdrawn ? (
          <Badge variant="destructive">Withdrawn</Badge>
        ) : null}
      </header>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">MIME</dt>
          <dd className="font-mono">{state.mimeType}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Bytes</dt>
          <dd className="font-mono tabular-nums">{state.bytes ?? "unknown"}</dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          onClick={() =>
            navigate.toPluginPanel("documents", {
              subPath: encodeURIComponent(state.documentId),
            })
          }
          size="sm"
          variant="secondary"
        >
          Open in Documents
        </Button>
        <Button asChild size="sm" variant="outline">
          <a href={state.contentHref}>Download content</a>
        </Button>
      </div>
    </section>
  );
}
