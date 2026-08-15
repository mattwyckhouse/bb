// @vitest-environment jsdom

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("renders a project picker in the unconfigured state and loads the selected project", async () => {
    const documentsList = vi.fn(async () => ({
      items: [],
      total: 0,
      next: null,
      cache: {
        state: "empty" as const,
        asOf: null,
        message: null,
        acceptedGenerationId: null,
        baseRevision: 0,
      },
    }));
    const unconfigured = renderSlot(
      panel,
      { subPath: "" },
      {
        context: { projectId: null, threadId: null },
        sidebarThreads: {
          status: "ready",
          projects: [{ id: "project-a", name: "Project A", isPersonal: false }],
          threads: [],
        },
        rpc: {
          bomCachedProjectVersions: async () => ({
            versions: [
              {
                platformProjectId: "platform-a",
                projectVersionId: "version-a",
                asOf: "2026-08-15T10:00:00.000Z",
                state: "fresh" as const,
              },
            ],
            selectedPlatformProjectId: "platform-a",
            selectedProjectVersionId: "version-a",
          }),
          documentsList,
        },
      },
    );
    expect(await unconfigured.findByText("Choose a project")).toBeTruthy();
    const projectPicker = unconfigured.getByLabelText("Project");
    expect(projectPicker).toBeTruthy();
    fireEvent.change(projectPicker, { target: { value: "project-a" } });
    expect(await unconfigured.findByText("No documents yet")).toBeTruthy();
    expect(documentsList).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-a",
        projectVersionId: null,
      }),
    );
    const versionPicker = await unconfigured.findByLabelText("Project version");
    fireEvent.change(versionPicker, { target: { value: "version-a" } });
    await waitFor(() =>
      expect(documentsList).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-a",
          projectVersionId: "version-a",
        }),
      ),
    );
    unconfigured.lifecycle.unmount();
  });

  it("loads documents from a custom version when cached versions are unavailable", async () => {
    const documentsGet = vi.fn(async () => ({}));
    const documentsList = vi.fn(async (input: unknown) => {
      const projectVersionId =
        typeof input === "object" &&
        input !== null &&
        typeof Reflect.get(input, "projectVersionId") === "string"
          ? String(Reflect.get(input, "projectVersionId"))
          : null;
      return {
        items:
          projectVersionId === "v1-not-in-bom-cache"
            ? [
                {
                  key: "document-custom",
                  label: "evidence.csv",
                  fields: {
                    docKind: "csv",
                    mimeType: "text/csv",
                    sha256: "a".repeat(64),
                    bytes: 12,
                    withdrawn: false,
                  },
                },
              ]
            : [],
        total: projectVersionId === "v1-not-in-bom-cache" ? 1 : 0,
        next: null,
        cache: {
          state: "empty" as const,
          asOf: null,
          message: null,
          acceptedGenerationId: null,
          baseRevision: 0,
        },
      };
    });
    const rendered = renderSlot(
      panel,
      { subPath: "" },
      {
        context: { projectId: "project-a", threadId: null },
        rpc: {
          bomCachedProjectVersions: async () => {
            throw new Error("BOM_PROJECT_SOURCE_REQUIRED");
          },
          documentsGet,
          documentsList,
        },
      },
    );

    expect(
      await rendered.findByText(
        "Cached versions unavailable: BOM_PROJECT_SOURCE_REQUIRED",
      ),
    ).toBeTruthy();
    fireEvent.change(rendered.getByLabelText("Project version"), {
      target: { value: "__custom__" },
    });
    expect(await rendered.findByText("Enter a custom version id")).toBeTruthy();
    const customVersionInput = rendered.getByLabelText("Custom version id");
    fireEvent.change(customVersionInput, {
      target: { value: "@project" },
    });
    expect(customVersionInput.getAttribute("aria-invalid")).toBe("true");
    expect(documentsList).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectVersionId: "@project" }),
    );
    fireEvent.change(customVersionInput, {
      target: { value: "v1-not-in-bom-cache" },
    });

    await waitFor(() =>
      expect(documentsList).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "project-a",
          projectVersionId: "v1-not-in-bom-cache",
        }),
      ),
    );
    await waitFor(() =>
      expect(documentsGet).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: "document-custom",
          projectId: "project-a",
          projectVersionId: "v1-not-in-bom-cache",
        }),
      ),
    );
    rendered.lifecycle.unmount();
  });

  it("renders loading/empty/error states", async () => {
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
