// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@bb/plugin-sdk/testing/app";

beforeAll(() => installTestPluginRuntime());
afterEach(() => cleanup());

const DOC_ID = "a".repeat(64);

function documentResult() {
  return {
    projectId: "project-1",
    projectVersionId: "version-1",
    kind: "document",
    key: DOC_ID,
    label: "BCM6755 datasheet.pdf",
    fields: {
      sha256: DOC_ID,
      path: "product-security/documents/a…-BCM6755.pdf",
      docKind: "datasheet",
      mimeType: "application/pdf",
      bytes: 1024,
      withdrawn: false,
      needsOcr: false,
      uploadedAt: "2026-08-15T00:00:00.000Z",
      retention: "plugin-local",
    },
    links: [],
    cache: {
      state: "fresh" as const,
      asOf: "2026-08-15T00:00:00.000Z",
      message: null,
      acceptedGenerationId: null,
      baseRevision: 0,
    },
  };
}

describe("DocumentCard", () => {
  it("builds AMD-0026 R2 content URLs with sha256 as a query param", async () => {
    const { documentContentHref } = await import("./document-card.js");
    const href = documentContentHref("project-1", "version-1", DOC_ID);
    expect(href).toContain("/documents/content?");
    expect(href).toContain(`sha256=${DOC_ID}`);
    expect(href).not.toMatch(/\/documents\/[a-f0-9]{64}\//u);
  });

  it("self-fetches by document id via documentsGet", async () => {
    const { DocumentCard } = await import("./document-card.js");
    const slot = renderSlot(
      { component: () => <DocumentCard id={DOC_ID} /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: { documentsGet: () => documentResult() },
      },
    );
    expect(
      await slot.findByLabelText("Document BCM6755 datasheet.pdf"),
    ).toBeTruthy();
    expect(slot.getByText(DOC_ID)).toBeTruthy();
    expect(slot.inspection.rpcCalls[0]).toMatchObject({
      method: "documentsGet",
      input: { documentId: DOC_ID },
    });
    const download = slot.getByRole("link", { name: "Download content" });
    expect(download.getAttribute("href")).toContain(`sha256=${DOC_ID}`);
  });

  it("rejects non-sha256 ids before RPC", async () => {
    const { DocumentCard } = await import("./document-card.js");
    const slot = renderSlot(
      { component: () => <DocumentCard id="not-a-digest" /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: { documentsGet: () => documentResult() },
      },
    );
    expect(await slot.findByText("Invalid document identity")).toBeTruthy();
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });

  it("renders missing/error states and opens Documents", async () => {
    const { DocumentCard } = await import("./document-card.js");
    const missing = renderSlot(
      { component: () => <DocumentCard id={DOC_ID} /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: {
          documentsGet: () => Promise.reject(new Error("DOCUMENT_NOT_FOUND")),
        },
      },
    );
    expect(await missing.findByText("Document not found")).toBeTruthy();

    let attempts = 0;
    const failing = renderSlot(
      { component: () => <DocumentCard id={DOC_ID} /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: {
          documentsGet: () => {
            attempts += 1;
            return Promise.reject(new Error("Injected document RPC failure"));
          },
        },
      },
    );
    expect(
      await failing.findByText("Injected document RPC failure"),
    ).toBeTruthy();
    fireEvent.click(failing.getByRole("button", { name: "Retry" }));
    expect(attempts).toBeGreaterThanOrEqual(2);

    const ready = renderSlot(
      { component: () => <DocumentCard id={DOC_ID} /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: { documentsGet: () => documentResult() },
      },
    );
    fireEvent.click(
      await ready.findByRole("button", { name: "Open in Documents" }),
    );
    expect(ready.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({
        method: "toPluginPanel",
        path: "documents",
        options: { subPath: DOC_ID },
      }),
    );
  });
});
