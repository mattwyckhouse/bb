// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../../../app.js"));
const panel = app.navPanels.find((entry) => entry.id === "documents")!;
const opener = app.fileOpeners.find(
  (entry) => entry.id === "finite-state-document",
)!;

afterEach(cleanup);

describe("documents viewer registration", () => {
  it("registers the documents nav panel and file opener", () => {
    expect(panel).toBeTruthy();
    expect(panel.title).toBe("Documents");
    expect(opener.extensions).toContain("pdf");
    expect(opener.extensions).toContain("xlsx");
  });

  it("renders unconfigured and loading/empty/error states", async () => {
    const unconfigured = renderSlot(
      panel,
      { subPath: "" },
      {
        context: { projectId: null, threadId: null },
        sidebarThreads: { status: "ready", projects: [], threads: [] },
      },
    );
    expect(await unconfigured.findByText("Choose a project")).toBeTruthy();
    unconfigured.lifecycle.unmount();

    const loading = renderSlot(
      panel,
      { subPath: "" },
      {
        context: { projectId: "project-a", threadId: null },
        rpc: {
          documentsList: () =>
            new Promise(() => {
              /* hang for loading skeleton */
            }),
        },
      },
    );
    expect(await loading.findByLabelText("Loading documents")).toBeTruthy();
    loading.lifecycle.unmount();

    const empty = renderSlot(
      panel,
      { subPath: "" },
      {
        context: { projectId: "project-a", threadId: null },
        rpc: {
          documentsList: async () => ({
            items: [],
            total: 0,
            next: null,
            cache: {
              state: "empty",
              asOf: null,
              message: null,
              acceptedGenerationId: null,
              baseRevision: 0,
            },
          }),
        },
      },
    );
    expect(await empty.findByText("No documents yet")).toBeTruthy();
    empty.lifecycle.unmount();

    const errored = renderSlot(
      panel,
      { subPath: "" },
      {
        context: { projectId: "project-a", threadId: null },
        rpc: {
          documentsList: async () => {
            throw new Error("stale cache");
          },
        },
      },
    );
    expect(await errored.findByText("Documents error")).toBeTruthy();
    expect(errored.getByText("stale cache")).toBeTruthy();
    errored.lifecycle.unmount();
  });

  it("file opener offers register-document when outside the ledger", async () => {
    const slot = renderSlot(
      opener,
      {
        path: "src/readme.txt",
        source: {
          kind: "workspace" as const,
          threadId: "thread-1",
          projectId: "project-a",
          environmentId: "env-1",
        },
      },
      {
        context: { projectId: "project-a", threadId: "thread-1" },
        rpc: {
          documentsList: async () => ({
            items: [],
            total: 0,
            next: null,
            cache: {
              state: "empty",
              asOf: null,
              message: null,
              acceptedGenerationId: null,
              baseRevision: 0,
            },
          }),
        },
      },
    );
    expect(await slot.findByText("Register document")).toBeTruthy();
    slot.lifecycle.unmount();
  });
});
