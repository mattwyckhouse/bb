import type Database from "better-sqlite3";
import type { BbPluginApi, PluginHttpHandler } from "@bb/plugin-sdk";
import {
  DOCUMENTS_CHANGED_CHANNEL,
  DocumentStoreError,
  uploadDocumentEnvelope,
} from "../store.js";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function createDocumentsUploadHandler(deps: {
  db: Database.Database;
  bb: BbPluginApi;
}): PluginHttpHandler {
  return async (http) => {
    let body: unknown;
    try {
      body = await http.req.json();
    } catch {
      return jsonError(
        "DOCUMENT_ENVELOPE_INVALID",
        "Upload body must be JSON.",
        400,
      );
    }
    try {
      const result = await uploadDocumentEnvelope(
        deps.db,
        deps.bb,
        body,
        (payload) => {
          deps.bb.realtime.publish(DOCUMENTS_CHANGED_CHANNEL, payload);
        },
      );
      return Response.json(
        {
          created: result.created,
          document: {
            projectId: result.record.projectId,
            projectVersionId: result.record.projectVersionId,
            documentId: result.record.documentId,
            sha256: result.record.sha256,
            name: result.record.name,
            path: result.record.path,
            kind: result.record.kind,
            mimeType: result.record.mimeType,
            bytes: result.record.bytes,
            uploadedAt: result.record.uploadedAt,
            retention: "plugin-local",
          },
        },
        { status: result.created ? 201 : 200 },
      );
    } catch (error) {
      if (error instanceof DocumentStoreError) {
        return jsonError(error.code, error.message, error.status);
      }
      throw error;
    }
  };
}
