import { useEffect, useState } from "react";
import {
  useBbContext,
  useRpc,
  type PluginFileOpenerProps,
} from "@bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { type RpcContract } from "../../../shared/contract.js";
import { DocumentViewer } from "./document-viewer.js";

function basename(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts[parts.length - 1] ?? path;
}

function parseTrackedDocument(path: string): {
  sha256: string;
  name: string;
} | null {
  const match =
    /(?:^|\/)product-security\/documents\/([a-f0-9]{64})-(.+)$/u.exec(path);
  if (!match) return null;
  return { sha256: match[1]!, name: match[2]! };
}

function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".svd") || lower.endsWith(".xml"))
    return "application/xml";
  return "text/plain";
}

function RegisterDocumentPrompt(props: {
  path: string;
  error: string | null;
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-lg rounded-lg border border-border bg-card p-6">
        <Icon className="size-6 text-muted-foreground" name="FileText" />
        <h2 className="mt-3 text-base font-semibold">Register document</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {basename(props.path)} is outside the documents ledger (or not yet
          uploaded). Register it through the Documents panel upload before
          extraction citations can resolve.
        </p>
        {props.error ? (
          <p className="mt-2 text-sm text-destructive">{props.error}</p>
        ) : null}
        <Button
          className="mt-4"
          onClick={() => {
            window.location.hash = "#plugin/documents";
          }}
          type="button"
          variant="outline"
        >
          Open Documents panel
        </Button>
      </div>
    </div>
  );
}

export function DocumentOpener(
  props: PluginFileOpenerProps,
): React.JSX.Element {
  const { projectId } = useBbContext();
  const rpc = useRpc<RpcContract>();
  const tracked = parseTrackedDocument(props.path);
  const trackedSha = tracked?.sha256 ?? null;
  const trackedName = tracked?.name ?? null;
  const needsLookup = Boolean(projectId && trackedSha);
  const [documentId, setDocumentId] = useState<string | null>(trackedSha);
  const [loading, setLoading] = useState(needsLookup);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState<boolean | null>(
    needsLookup ? null : false,
  );

  useEffect(() => {
    if (!projectId || trackedSha === null) return;
    let cancelled = false;
    void rpc
      .call(
        "documentsList",
        Object.assign(
          {
            projectId,
            projectVersionId: null,
            pageSize: 50,
            continuation: null,
          },
          { filters: {} },
        ),
      )
      .then((page) => {
        if (cancelled) return;
        const match = page.items.find((item) => {
          const sha =
            typeof item.fields.sha256 === "string"
              ? item.fields.sha256
              : item.key;
          return sha === trackedSha;
        });
        setDocumentId(match?.key ?? trackedSha);
        setRegistered(Boolean(match));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not resolve document ledger entry.",
        );
        setRegistered(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, props.path, rpc, trackedSha]);

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <Icon
            className="mx-auto size-6 text-muted-foreground"
            name="FolderOpen"
          />
          <h2 className="mt-3 text-base font-semibold">Choose a project</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Open this file from a project workspace to register or preview it as
            evidence.
          </p>
        </div>
      </div>
    );
  }

  if (trackedSha === null || trackedName === null) {
    return <RegisterDocumentPrompt error={null} path={props.path} />;
  }

  if (loading || registered === null) {
    return (
      <div
        aria-label="Loading document opener"
        className="space-y-3 p-4"
        role="status"
      >
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (registered === false) {
    return <RegisterDocumentPrompt error={error} path={props.path} />;
  }

  const mimeType = mimeFromName(trackedName);
  const contentHref = `/api/v1/plugins/finite-state/http/documents/content?sha256=${encodeURIComponent(trackedSha)}&projectId=${encodeURIComponent(projectId)}&projectVersionId=`;

  return (
    <DocumentViewer
      contentHref={contentHref}
      documentId={documentId ?? trackedSha}
      mimeType={mimeType}
      name={trackedName}
      projectId={projectId}
      projectVersionId={null}
      sha256={trackedSha}
    />
  );
}
