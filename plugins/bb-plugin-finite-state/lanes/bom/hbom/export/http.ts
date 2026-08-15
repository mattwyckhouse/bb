import { Readable } from "node:stream";

import type { BbPluginApi, PluginHttpHandler } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";

import { resolveProjectWorktreeRoot } from "../../../documents/store.js";
import { CDX_HBOM_UNVERIFIED, createCycloneDxHbom } from "./cyclonedx.js";
import {
  createHbomWorkbook,
  HbomExportError,
  type ExportArtifact,
  type ExportDeps,
  type HbomExportMode,
} from "./xlsx.js";

function queryError(code: string, message: string, status = 400): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: { "x-content-type-options": "nosniff" },
    },
  );
}

function parseMode(value: string | null): HbomExportMode | null {
  if (value === null || value === "full") return "full";
  if (value === "verified-only") return "verified-only";
  return null;
}

function sanitizeContentDispositionFilename(filename: string): string {
  return filename.replace(/[^\w.-]+/gu, "_").replaceAll('"', "");
}

function errorResponse(error: unknown): Response {
  if (error instanceof HbomExportError) {
    const status = error.code === CDX_HBOM_UNVERIFIED ? 501 : 400;
    return queryError(error.code, error.message, status);
  }
  return queryError(
    "HBOM_EXPORT_FAILED",
    "The HBOM export could not be generated.",
    500,
  );
}

function responseBody(
  artifact: ExportArtifact,
  abort: AbortController,
  onSettled: () => void,
): ReadableStream<Uint8Array> {
  if (!(artifact.stream instanceof Readable)) {
    throw new Error("HBOM export produced an unsupported stream");
  }
  const reader = Readable.toWeb(artifact.stream).getReader();
  let settled = false;

  const dispose = async () => {
    if (settled) return;
    settled = true;
    try {
      await artifact.dispose();
    } finally {
      onSettled();
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          await dispose();
          return;
        }
        controller.enqueue(next.value);
      } catch {
        abort.abort();
        controller.error(new Error("HBOM export stream failed"));
        await dispose();
      }
    },
    async cancel(reason) {
      abort.abort();
      await reader.cancel(reason).catch(() => undefined);
      await dispose();
    },
  });
}

export interface HbomHttpExportDeps {
  db: Database.Database;
  bb: BbPluginApi;
}

async function resolveExportDeps(
  deps: HbomHttpExportDeps,
  projectId: string,
  projectVersionId: string | null,
  projectKey: string,
): Promise<ExportDeps> {
  const root = await resolveProjectWorktreeRoot(deps.bb, projectId);
  return {
    db: deps.db,
    root,
    projectId,
    projectVersionId,
    projectKey,
  };
}

function parseProjectVersionId(raw: string | null): string | null {
  if (raw === null || raw.length === 0) return null;
  if (raw === "@project") {
    throw new HbomExportError(
      "HBOM_PROJECT_VERSION_INVALID",
      'External "@project" is rejected; omit projectVersionId for null.',
    );
  }
  return raw;
}

async function handleExport(
  deps: HbomHttpExportDeps,
  context: Parameters<PluginHttpHandler>[0],
  kind: "xlsx" | "cdx",
): Promise<Response> {
  const url = new URL(context.req.url);
  const project =
    url.searchParams.get("project") ?? url.searchParams.get("projectId");
  const mode = parseMode(url.searchParams.get("mode"));
  let projectVersionId: string | null;
  try {
    projectVersionId = parseProjectVersionId(
      url.searchParams.get("projectVersionId"),
    );
  } catch (error: unknown) {
    return errorResponse(error);
  }

  if (project === null || project.trim().length < 1) {
    return queryError(
      "HBOM_PROJECT_INVALID",
      "project (or projectId) query parameter is required.",
    );
  }
  if (mode === null) {
    return queryError(
      "HBOM_EXPORT_MODE_INVALID",
      "mode must be full or verified-only.",
    );
  }

  const abort = new AbortController();
  const disconnect = () => abort.abort();
  context.req.raw.signal.addEventListener("abort", disconnect, { once: true });

  let artifact: ExportArtifact;
  try {
    const exportDeps = await resolveExportDeps(
      deps,
      project,
      projectVersionId,
      project,
    );
    artifact =
      kind === "xlsx"
        ? await createHbomWorkbook(exportDeps, mode)
        : await createCycloneDxHbom(exportDeps, mode);
    if (abort.signal.aborted) {
      await artifact.dispose();
      return queryError("HBOM_EXPORT_CANCELLED", "Export cancelled.", 499);
    }
  } catch (error: unknown) {
    context.req.raw.signal.removeEventListener("abort", disconnect);
    return errorResponse(error);
  }

  let body: ReadableStream<Uint8Array>;
  try {
    body = responseBody(artifact, abort, () =>
      context.req.raw.signal.removeEventListener("abort", disconnect),
    );
  } catch (error: unknown) {
    await artifact.dispose();
    context.req.raw.signal.removeEventListener("abort", disconnect);
    return errorResponse(error);
  }

  const filename = sanitizeContentDispositionFilename(artifact.filename);
  const headers = new Headers({
    "cache-control": "no-store",
    "content-disposition": `attachment; filename="${filename}"`,
    "content-type": artifact.contentType,
    "x-content-type-options": "nosniff",
  });
  if (artifact.bytes !== null) {
    headers.set("content-length", String(artifact.bytes));
  }
  return new Response(body, { status: 200, headers });
}

export function createHbomXlsxHttpHandler(
  deps: HbomHttpExportDeps,
): PluginHttpHandler {
  return (context) => handleExport(deps, context, "xlsx");
}

export function createHbomCycloneDxHttpHandler(
  deps: HbomHttpExportDeps,
): PluginHttpHandler {
  return (context) => handleExport(deps, context, "cdx");
}
