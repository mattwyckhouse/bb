import type { BbPluginApi } from "@bb/plugin-sdk";
import type { PluginContext } from "../../lib/context.js";
import type { JsonValue } from "../../shared/contract.js";
import { rpcContract } from "../../shared/contract.js";
import { createDocumentsContentHandler } from "./http/content.js";
import { createDocumentsUploadHandler } from "./http/upload.js";
import {
  listDocumentExtractions,
  listDocuments,
  recordDocumentExtractions,
  searchDocuments,
} from "./search.js";
import { decodeSourceRef, encodeSourceRef } from "./source-ref.js";
import {
  DocumentStoreError,
  documentSummaryFields,
  emptyCache,
  getDocumentById,
  updateDocumentMetadata,
  type DocumentKind,
} from "./store.js";

const documentsRpcContract = {
  documentsList: rpcContract.documentsList,
  documentsGet: rpcContract.documentsGet,
  documentsSearch: rpcContract.documentsSearch,
  documentsMetadataUpdate: rpcContract.documentsMetadataUpdate,
  documentsExtractionsList: rpcContract.documentsExtractionsList,
} as const;

export interface DocumentsServices {
  encodeSourceRef: typeof encodeSourceRef;
  decodeSourceRef: typeof decodeSourceRef;
  searchDocuments: typeof searchDocuments;
  recordDocumentExtractions: typeof recordDocumentExtractions;
}

function throwStoreError(error: unknown): never {
  if (error instanceof DocumentStoreError) {
    throw new Error(`${error.code}: ${error.message}`);
  }
  throw error;
}

function readString(input: object, key: string): string {
  const value = Reflect.get(input, key);
  if (typeof value !== "string" || value.length < 1) {
    throw new DocumentStoreError(
      "DOCUMENT_INPUT_INVALID",
      `Missing required string field ${key}.`,
    );
  }
  return value;
}

function readOptionalStringArray(
  input: object,
  key: string,
): string[] | undefined {
  const value = Reflect.get(input, key);
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DocumentStoreError(
      "DOCUMENT_INPUT_INVALID",
      `Field ${key} must be a string array when provided.`,
    );
  }
  return value;
}

function readFilters(input: object): Record<string, JsonValue> {
  const value = Reflect.get(input, "filters");
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DocumentStoreError(
      "DOCUMENT_INPUT_INVALID",
      "filters must be an object.",
    );
  }
  return Object.fromEntries(Object.entries(value));
}

function readDocumentKind(input: object): DocumentKind {
  const value = readString(input, "kind");
  if (
    value === "datasheet" ||
    value === "bom" ||
    value === "schematic" ||
    value === "spec" ||
    value === "regulatory" ||
    value === "register_map" ||
    value === "other"
  ) {
    return value;
  }
  throw new DocumentStoreError(
    "DOCUMENT_TYPE_UNSUPPORTED",
    "doc_kind is outside the frozen vocabulary.",
  );
}

export function registerDocuments(bb: BbPluginApi, ctx: PluginContext): void {
  const db = ctx.db();

  ctx.service<DocumentsServices>("documents.services", () => ({
    encodeSourceRef,
    decodeSourceRef,
    searchDocuments,
    recordDocumentExtractions,
  }));

  bb.rpc.register(documentsRpcContract, {
    documentsList(input) {
      try {
        return listDocuments(db, input, {
          pageSize: input.pageSize,
          continuation: input.continuation,
          filters: readFilters(input),
        });
      } catch (error) {
        throwStoreError(error);
      }
    },
    documentsGet(input) {
      try {
        const documentId = readString(input, "documentId");
        const record = getDocumentById(db, input, documentId);
        if (!record) {
          throw new DocumentStoreError(
            "DOCUMENT_NOT_FOUND",
            "Document is unknown in this project/version scope.",
            404,
          );
        }
        return {
          projectId: record.projectId,
          projectVersionId: record.projectVersionId,
          kind: "document",
          key: record.documentId,
          label: record.name,
          fields: documentSummaryFields(record),
          links: [],
          cache: emptyCache(record.withdrawn ? "stale" : "fresh"),
        };
      } catch (error) {
        throwStoreError(error);
      }
    },
    documentsSearch(input) {
      try {
        const page = searchDocuments(db, input, {
          query: readString(input, "query"),
          kinds: readOptionalStringArray(input, "kinds"),
          pageSize: input.pageSize,
          continuation: input.continuation,
        });
        return {
          items: page.items.map((hit) => ({
            projectId: hit.projectId,
            projectVersionId: hit.projectVersionId,
            documentSha256: hit.documentSha256,
            documentName: hit.documentName,
            field: hit.field,
            value: hit.value,
            confidence: hit.confidence,
            sourceRef: hit.sourceRef,
            snippet: hit.snippet ?? null,
            target: hit.target
              ? {
                  projectId: hit.projectId,
                  projectVersionId: hit.projectVersionId,
                  kind: hit.target.surface,
                  key: hit.target.id,
                  label: hit.target.field
                    ? `${hit.target.surface}:${hit.target.id}.${hit.target.field}`
                    : `${hit.target.surface}:${hit.target.id}`,
                }
              : null,
          })),
          total: page.total,
          next: page.next,
          cache: page.cache,
        };
      } catch (error) {
        throwStoreError(error);
      }
    },
    documentsMetadataUpdate(input) {
      try {
        const withdrawn = Reflect.get(input, "withdrawn");
        if (typeof withdrawn !== "boolean") {
          throw new DocumentStoreError(
            "DOCUMENT_INPUT_INVALID",
            "withdrawn must be a boolean.",
          );
        }
        const record = updateDocumentMetadata(db, input, {
          documentId: readString(input, "documentId"),
          expectedContentSha256: readString(input, "expectedContentSha256"),
          kind: readDocumentKind(input),
          withdrawn,
          displayName: readString(input, "displayName"),
        });
        bb.realtime.publish("documents:changed", {
          projectId: record.projectId,
          projectVersionId: record.projectVersionId,
          documentSha256: record.sha256,
        });
        return {
          projectId: record.projectId,
          projectVersionId: record.projectVersionId,
          kind: "document",
          key: record.documentId,
          label: record.name,
          fields: documentSummaryFields(record),
          links: [],
          cache: emptyCache("fresh"),
        };
      } catch (error) {
        throwStoreError(error);
      }
    },
    documentsExtractionsList(input) {
      try {
        return listDocumentExtractions(db, input, {
          documentId: readString(input, "documentId"),
          pageSize: input.pageSize,
          continuation: input.continuation,
        });
      } catch (error) {
        throwStoreError(error);
      }
    },
  });

  bb.http.route(
    "POST",
    "/documents/upload",
    createDocumentsUploadHandler({ db, bb }),
    { auth: "local" },
  );
  bb.http.route(
    "GET",
    "/documents/content",
    createDocumentsContentHandler({ db, bb }),
    { auth: "local" },
  );
}
