import type Database from "better-sqlite3";
import type { BbPluginApi, PluginHttpHandler } from "@bb/plugin-sdk";
import {
  DocumentStoreError,
  getDocumentBySha,
  readDocumentBytes,
  resolveProjectWorktreeRoot,
} from "../store.js";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function parseByteRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value);
  if (!match) throw new Error("INVALID_RANGE");
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    throw new Error("INVALID_RANGE");
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function safeContentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/gu, "_").replaceAll('"', "");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function parseProjectVersionId(raw: string | undefined): string | null {
  if (raw === undefined) {
    throw new DocumentStoreError(
      "DOCUMENT_SCOPE_INVALID",
      "projectVersionId query parameter is required (empty string for null).",
    );
  }
  if (raw === "@project") {
    throw new DocumentStoreError(
      "DOCUMENT_SENTINEL_REJECTED",
      'External "@project" is rejected; use an empty projectVersionId for null.',
    );
  }
  return raw.length === 0 ? null : raw;
}

export function createDocumentsContentHandler(deps: {
  db: Database.Database;
  bb: BbPluginApi;
}): PluginHttpHandler {
  return async (http) => {
    try {
      // Caller-supplied paths are ignored; resolution is scoped SHA only.
      void http.req.query("path");
      void http.req.query("file");

      const sha256 = http.req.query("sha256");
      const projectId = http.req.query("projectId");
      const projectVersionRaw = http.req.query("projectVersionId");
      if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
        return jsonError(
          "DOCUMENT_SHA256_INVALID",
          "sha256 query parameter must be a lowercase 64-hex digest.",
          400,
        );
      }
      if (typeof projectId !== "string" || projectId.length < 1) {
        return jsonError(
          "DOCUMENT_SCOPE_INVALID",
          "projectId query parameter is required.",
          400,
        );
      }
      const projectVersionId = parseProjectVersionId(projectVersionRaw);
      const record = getDocumentBySha(
        deps.db,
        { projectId, projectVersionId },
        sha256,
      );
      if (!record || record.withdrawn) {
        return jsonError(
          "DOCUMENT_NOT_FOUND",
          "No document matches the scoped SHA.",
          404,
        );
      }
      const worktreeRoot = await resolveProjectWorktreeRoot(deps.bb, projectId);
      const bytes = readDocumentBytes(worktreeRoot, record);
      let range: { start: number; end: number } | null;
      try {
        range = parseByteRange(http.req.header("range"), bytes.byteLength);
      } catch {
        return new Response(null, {
          status: 416,
          headers: {
            "Content-Range": `bytes */${bytes.byteLength}`,
            "Accept-Ranges": "bytes",
          },
        });
      }
      const selected = range
        ? bytes.subarray(range.start, range.end + 1)
        : bytes;
      const headers = new Headers({
        "Content-Type": record.mimeType,
        "Content-Disposition": safeContentDisposition(record.name),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": String(selected.byteLength),
      });
      if (range) {
        headers.set(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
        );
      }
      return new Response(new Uint8Array(selected), {
        status: range ? 206 : 200,
        headers,
      });
    } catch (error) {
      if (error instanceof DocumentStoreError) {
        return jsonError(error.code, error.message, error.status);
      }
      throw error;
    }
  };
}
