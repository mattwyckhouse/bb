import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { Skeleton } from "@bb/shared-ui/skeleton";
import {
  experimental_useSidebarThreads,
  useBbContext,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
} from "@bb/plugin-sdk/app";
import { type RpcContract } from "../../../shared/contract.js";
import { bomCachedVersionsContract } from "../../bom/rpc.js";
import { DocumentViewer } from "./document-viewer.js";

type PanelState =
  | "unconfigured"
  | "custom-version"
  | "loading"
  | "empty"
  | "ready"
  | "error";

const CUSTOM_VERSION_VALUE = "__custom__";

interface DocumentListItem {
  documentId: string;
  name: string;
  kind: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  withdrawn: boolean;
}

function contentUrl(
  projectId: string,
  projectVersionId: string | null,
  sha256: string,
): string {
  const version =
    projectVersionId === null ? "" : encodeURIComponent(projectVersionId);
  return `/api/v1/plugins/finite-state/http/documents/content?sha256=${encodeURIComponent(sha256)}&projectId=${encodeURIComponent(projectId)}&projectVersionId=${version}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function DocumentsPanel(_props: PluginNavPanelProps): React.JSX.Element {
  const { projectId: routeProjectId } = useBbContext();
  const sidebar = experimental_useSidebarThreads();
  const rpc = useRpc<RpcContract & typeof bomCachedVersionsContract>();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const projectId = routeProjectId ?? selectedProjectId;
  const [versions, setVersions] = useState<
    Array<{
      platformProjectId: string;
      projectVersionId: string;
      state: "fresh" | "stale";
    }>
  >([]);
  const [projectVersionId, setProjectVersionId] = useState<string | null>(null);
  const [customVersionSelected, setCustomVersionSelected] = useState(false);
  const [customVersionId, setCustomVersionId] = useState("");
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [versionRequest, setVersionRequest] = useState(0);
  const [items, setItems] = useState<DocumentListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<PanelState>(
    projectId ? "loading" : "unconfigured",
  );
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const listParent = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setProjectVersionId(null);
    setCustomVersionSelected(false);
    setCustomVersionId("");
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setVersions([]);
      setVersionsLoading(false);
      setVersionsError(null);
      return;
    }
    let active = true;
    setVersions([]);
    setVersionsLoading(true);
    setVersionsError(null);
    void rpc
      .call("bomCachedProjectVersions", { projectId })
      .then((result) => {
        if (active) setVersions(result.versions);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setVersions([]);
        setVersionsError(
          cause instanceof Error
            ? cause.message
            : "Cached project versions could not be loaded.",
        );
      })
      .finally(() => {
        if (active) setVersionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, rpc, versionRequest]);

  useEffect(() => {
    if (!projectId) {
      setState("unconfigured");
      setItems([]);
      setSelectedId(null);
      return;
    }
    if (
      customVersionSelected &&
      (customVersionId.length === 0 || customVersionId === "@project")
    ) {
      setState("custom-version");
      setItems([]);
      setSelectedId(null);
      return;
    }
    let cancelled = false;
    setState("loading");
    setError(null);
    void rpc
      .call(
        "documentsList",
        Object.assign(
          {
            projectId,
            projectVersionId,
            pageSize: 100,
            continuation: null,
          },
          { filters: {} },
        ),
      )
      .then((page) => {
        if (cancelled) return;
        const next = page.items.map((item) => {
          const fields = item.fields;
          return {
            documentId: item.key,
            name: item.label,
            kind: typeof fields.docKind === "string" ? fields.docKind : "other",
            mimeType:
              typeof fields.mimeType === "string"
                ? fields.mimeType
                : "application/octet-stream",
            sha256:
              typeof fields.sha256 === "string" ? fields.sha256 : item.key,
            bytes: typeof fields.bytes === "number" ? fields.bytes : 0,
            withdrawn: fields.withdrawn === true,
          };
        });
        setItems(next);
        setSelectedId((current) =>
          current && next.some((item) => item.documentId === current)
            ? current
            : (next[0]?.documentId ?? null),
        );
        setState(next.length === 0 ? "empty" : "ready");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Documents could not be loaded.",
        );
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [
    customVersionId,
    customVersionSelected,
    projectId,
    projectVersionId,
    revision,
    rpc,
  ]);

  useRealtime("documents:changed", (payload) => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      Reflect.get(payload, "projectId") === projectId
    ) {
      setRevision((value) => value + 1);
    }
  });

  const selected = useMemo(
    () => items.find((item) => item.documentId === selectedId) ?? null,
    [items, selectedId],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listParent.current,
    estimateSize: () => 44,
    overscan: 8,
  });

  async function onUpload(file: File): Promise<void> {
    if (!projectId) return;
    setUploading(true);
    setError(null);
    try {
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength > 50 * 1024 * 1024) {
        throw new Error(
          "DOCUMENT_OVERSIZED: Decoded document exceeds the 50 MiB cap.",
        );
      }
      const sha256 = await sha256Hex(buffer);
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let index = 0; index < bytes.byteLength; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      const contentBase64 = btoa(binary);
      const response = await fetch(
        "/api/v1/plugins/finite-state/http/documents/upload",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            envelopeVersion: 1,
            projectId,
            projectVersionId,
            filename: file.name,
            sha256,
            metadata: {},
            contentBase64,
          }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code =
          typeof body === "object" &&
          body !== null &&
          typeof Reflect.get(Reflect.get(body, "error") ?? {}, "code") ===
            "string"
            ? String(Reflect.get(Reflect.get(body, "error") ?? {}, "code"))
            : "DOCUMENT_UPLOAD_FAILED";
        throw new Error(`${code}: upload failed (${response.status})`);
      }
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Upload failed.");
      setState((current) => (current === "empty" ? "error" : current));
    } finally {
      setUploading(false);
    }
  }

  if (state === "unconfigured") {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 text-foreground">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <Icon
            className="mx-auto size-6 text-muted-foreground"
            name="FolderOpen"
          />
          <h2 className="mt-3 text-base font-semibold">Choose a project</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Documents are plugin-local evidence stored under
            product-security/documents in the selected workspace.
          </p>
          <label
            className="mt-4 block text-left text-xs font-medium text-muted-foreground"
            htmlFor="documents-project"
          >
            Project
          </label>
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            disabled={sidebar.status === "loading"}
            id="documents-project"
            onChange={(event) => {
              setSelectedProjectId(event.target.value || null);
              setProjectVersionId(null);
              setCustomVersionSelected(false);
              setCustomVersionId("");
            }}
            value={projectId ?? ""}
          >
            <option value="">
              {sidebar.status === "loading"
                ? "Loading projects…"
                : "Select project"}
            </option>
            {sidebar.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      <section className="flex w-80 shrink-0 flex-col border-r border-border">
        <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div>
            <h1 className="text-sm font-semibold">Documents</h1>
            <p className="text-xs text-muted-foreground">
              Plugin-local evidence · not AS-retained
            </p>
          </div>
          <Button
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            size="sm"
            type="button"
            variant="outline"
          >
            <Icon className="size-4" name="Plus" />
            Add
          </Button>
          <input
            accept=".pdf,.csv,.xlsx,.svd,.xml,.txt,.h,.hpp,.c,.inc"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void onUpload(file);
            }}
            ref={fileInput}
            type="file"
          />
        </header>
        <div className="space-y-2 border-b border-border px-3 py-2">
          {!routeProjectId ? (
            <div>
              <label
                className="text-xs text-muted-foreground"
                htmlFor="documents-project"
              >
                Project
              </label>
              <select
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                id="documents-project"
                onChange={(event) => {
                  setSelectedProjectId(event.target.value || null);
                  setProjectVersionId(null);
                  setCustomVersionSelected(false);
                  setCustomVersionId("");
                }}
                value={projectId ?? ""}
              >
                <option value="">Select project</option>
                {sidebar.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <label
            className="block text-xs text-muted-foreground"
            htmlFor="docs-version"
          >
            Project version
          </label>
          <select
            className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            disabled={versionsLoading}
            id="docs-version"
            onChange={(event) => {
              const value = event.target.value;
              if (value === CUSTOM_VERSION_VALUE) {
                setCustomVersionSelected(true);
                setCustomVersionId("");
                setProjectVersionId(null);
                return;
              }
              setCustomVersionSelected(false);
              setCustomVersionId("");
              setProjectVersionId(value || null);
            }}
            value={
              customVersionSelected
                ? CUSTOM_VERSION_VALUE
                : (projectVersionId ?? "")
            }
          >
            <option value="">
              {versionsLoading ? "Loading cached versions…" : "Project-level"}
            </option>
            {versions.map((version) => (
              <option
                key={`${version.platformProjectId}/${version.projectVersionId}`}
                value={version.projectVersionId}
              >
                {version.platformProjectId} / {version.projectVersionId}
                {version.state === "stale" ? " · stale" : ""}
              </option>
            ))}
            <option value={CUSTOM_VERSION_VALUE}>Custom version id…</option>
          </select>
          {customVersionSelected ? (
            <div>
              <label
                className="mt-2 block text-xs text-muted-foreground"
                htmlFor="docs-custom-version"
              >
                Custom version id
              </label>
              <input
                aria-describedby="docs-custom-version-help"
                aria-invalid={customVersionId === "@project"}
                autoFocus
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                id="docs-custom-version"
                onChange={(event) => {
                  const value = event.target.value;
                  setCustomVersionId(value);
                  setProjectVersionId(
                    value.length > 0 && value !== "@project" ? value : null,
                  );
                }}
                placeholder="version id"
                value={customVersionId}
              />
              <p
                className={`mt-1 text-xs ${customVersionId === "@project" ? "text-destructive" : "text-muted-foreground"}`}
                id="docs-custom-version-help"
              >
                Enter a non-empty version id other than @project.
              </p>
            </div>
          ) : null}
          {versionsError ? (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 p-2"
              role="alert"
            >
              <p className="text-xs text-destructive">
                Cached versions unavailable: {versionsError}
              </p>
              <Button
                className="mt-2"
                onClick={() => setVersionRequest((value) => value + 1)}
                size="sm"
                type="button"
                variant="outline"
              >
                Retry cached versions
              </Button>
            </div>
          ) : null}
        </div>
        {state === "loading" ? (
          <div
            aria-label="Loading documents"
            className="space-y-2 p-3"
            role="status"
          >
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton className="h-10 w-full" key={index} />
            ))}
          </div>
        ) : null}
        {state === "custom-version" ? (
          <div className="m-3 rounded-lg border border-border bg-card p-4 text-center">
            <p className="text-sm font-medium">Enter a custom version id</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Documents will load after you enter a valid version scope.
            </p>
          </div>
        ) : null}
        {state === "error" ? (
          <div className="m-3 rounded-lg border border-border bg-card p-4">
            <p className="text-sm font-medium text-destructive">
              Documents error
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            <Button
              className="mt-3"
              onClick={() => setRevision((value) => value + 1)}
              size="sm"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        ) : null}
        {state === "empty" ? (
          <div className="m-3 rounded-lg border border-border bg-card p-4 text-center">
            <Icon
              className="mx-auto size-5 text-muted-foreground"
              name="FileText"
            />
            <p className="mt-2 text-sm font-medium">No documents yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add a PDF, CSV, XLSX, SVD, or header file to start citing
              evidence.
            </p>
            <Button
              className="mt-3"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
              size="sm"
              type="button"
            >
              Add document
            </Button>
          </div>
        ) : null}
        {state === "ready" ? (
          <div className="min-h-0 flex-1 overflow-auto" ref={listParent}>
            <div
              className="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
              {virtualizer.getVirtualItems().map((row) => {
                const item = items[row.index]!;
                const active = item.documentId === selectedId;
                return (
                  <button
                    className={`absolute left-0 flex w-full items-start gap-2 border-b border-border/60 px-3 py-2 text-left text-sm hover:bg-muted ${active ? "bg-muted" : ""}`}
                    key={item.documentId}
                    onClick={() => setSelectedId(item.documentId)}
                    style={{ transform: `translateY(${row.start}px)` }}
                    type="button"
                  >
                    <Icon
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      name="FileText"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {item.name}
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                        {item.kind} · {item.sha256.slice(0, 12)}…
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </section>
      <section className="min-w-0 flex-1">
        {projectId && selected ? (
          <DocumentViewer
            contentHref={contentUrl(
              projectId,
              projectVersionId,
              selected.sha256,
            )}
            documentId={selected.documentId}
            mimeType={selected.mimeType}
            name={selected.name}
            projectId={projectId}
            projectVersionId={projectVersionId}
            sha256={selected.sha256}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a document to preview evidence locators.
          </div>
        )}
      </section>
    </div>
  );
}
