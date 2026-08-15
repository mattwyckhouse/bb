// @vitest-environment jsdom

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import {
  createFakePluginHost,
  type FakeRealtimeSignal,
} from "@bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPluginContext } from "../../lib/context.js";
import { AssuranceStudioClient } from "../../lib/remote/assurance-studio/client.js";
import { PlatformClient } from "../../lib/remote/platform/client.js";
import type { RemoteServices } from "../../lib/remote/types.js";
import { connectedRemoteStatus } from "../../test/app-connections.js";
import { registerPlatformHandlers } from "../../test/mock-remote/platform/register.js";
import { createMockPlatformState } from "../../test/mock-remote/platform/state.js";
import { createMockRemote } from "../../test/mock-remote/server.js";
import { rpcContract } from "../../shared/contract.js";
import { registerSync } from "../sync/register.js";
import { registerBom } from "./register.js";
import { bomCachedVersionsContract } from "./rpc.js";

const FIXTURE_ROOT = resolve(
  import.meta.dirname,
  "../../test/mock-remote/fixtures",
);

const emptyCache = {
  state: "empty" as const,
  asOf: null,
  message: null,
  acceptedGenerationId: null,
  baseRevision: 0,
};

class TableResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    queueMicrotask(() =>
      this.callback(
        [
          {
            target,
            contentRect: new DOMRectReadOnly(0, 0, 1200, 600),
            borderBoxSize: [{ blockSize: 600, inlineSize: 1200 }],
            contentBoxSize: [{ blockSize: 600, inlineSize: 1200 }],
            devicePixelContentBoxSize: [{ blockSize: 600, inlineSize: 1200 }],
          },
        ],
        this,
      ),
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

function requiredId(
  row: Record<string, unknown> | undefined,
  label: string,
): string {
  const id = row?.["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${label} has no id`);
  }
  return id;
}

beforeAll(() => {
  configure({ asyncUtilTimeout: 10_000 });
  vi.stubGlobal("ResizeObserver", TableResizeObserver);
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 600,
  });
});

afterEach(() => cleanup());

describe("registered BOM realtime boundary", () => {
  it("keeps cached Platform ids out of registered HBOM worktree resolution", async () => {
    const workspaceProjectId = "workspace-project-fs236";
    const platformProjectId = "platform-project-fs236";
    const projectVersionId = "platform-version-fs236";
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "finite-state-fs236-")),
    );
    const requestedProjectIds: string[] = [];
    const host = createFakePluginHost({
      pluginId: "finite-state-fs236-hbom-id-boundary",
      sdk: {
        projects: {
          get: ({ projectId }) => {
            requestedProjectIds.push(projectId);
            if (projectId !== workspaceProjectId) {
              throw new Error("HTTP 404: Project not found");
            }
            return {
              id: workspaceProjectId,
              sources: [{ id: "source-fs236", path: root, isDefault: true }],
            };
          },
        },
      },
    });

    try {
      const ctx = createPluginContext(host.bb);
      const db = ctx.db();
      registerBom(host.bb, ctx);
      db.prepare(
        `INSERT INTO pull_generation
         (project_id, project_version_id, generation_id, status,
          requested_kinds_json, started_at, completed_at, accepted_at)
         VALUES (?, ?, 'generation-fs236', 'accepted', '["sbomComponent"]',
                 '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z',
                 '2026-08-15T00:00:00.000Z')`,
      ).run(platformProjectId, projectVersionId);
      db.prepare(
        `INSERT INTO sync_state
         (project_id, project_version_id, entity_kind, accepted_generation_id,
          last_pull)
         VALUES (?, ?, 'sbomComponent', 'generation-fs236',
                 '2026-08-15T00:00:00.000Z')`,
      ).run(platformProjectId, projectVersionId);
      db.prepare(
        `INSERT INTO workspace_platform_project_binding
         (workspace_project_id, platform_project_id)
         VALUES (?, ?)`,
      ).run(workspaceProjectId, platformProjectId);

      const app = await loadPluginApp(() => import("../../app.js"));
      const panel = app.navPanels.find((candidate) => candidate.path === "bom");
      if (!panel) throw new Error("BOM panel not registered");
      const PanelComponent = panel.component;
      const slot = renderSlot(
        panel,
        { subPath: "software" },
        {
          sidebarThreads: {
            status: "ready",
            projects: [
              {
                id: workspaceProjectId,
                name: "FS-236 Workspace",
                isPersonal: false,
              },
            ],
          },
          rpc: {
            connectionsStatus: connectedRemoteStatus,
            async bomCachedProjectVersions(input) {
              return bomCachedVersionsContract.bomCachedProjectVersions.output.parse(
                await host.harness.behavior.callRpc(
                  "bomCachedProjectVersions",
                  input,
                ),
              );
            },
            bomSoftwareList: () => ({
              items: [],
              total: 0,
              next: null,
              cache: emptyCache,
            }),
            async bomComponentGet(input) {
              return rpcContract.bomComponentGet.output.parse(
                await host.harness.behavior.callRpc("bomComponentGet", input),
              );
            },
            async hbomReviewList(input) {
              return rpcContract.hbomReviewList.output.parse(
                await host.harness.behavior.callRpc("hbomReviewList", input),
              );
            },
            firmwareMountsList: () => ({
              items: [],
              total: 0,
              next: null,
              cache: emptyCache,
            }),
          },
        },
      );

      const projectPicker = await slot.findByRole("combobox", {
        name: "Project",
      });
      expect(slot.getAllByRole("combobox", { name: "Project" })).toHaveLength(
        1,
      );
      fireEvent.change(projectPicker, {
        target: { value: workspaceProjectId },
      });

      await waitFor(() => {
        const versionPicker = slot.getByRole("combobox", {
          name: "Finite State project version",
        });
        if (!(versionPicker instanceof HTMLSelectElement)) {
          throw new Error("Version picker did not render as a select");
        }
        expect(versionPicker.value).toBe(
          `${platformProjectId}/${projectVersionId}`,
        );
      });

      slot.lifecycle.rerender(<PanelComponent subPath="hardware" />);

      expect(await slot.findByText("No hardware parts")).toBeTruthy();
      const retainedVersionPicker = slot.getByRole("combobox", {
        name: "Finite State project version",
      });
      if (!(retainedVersionPicker instanceof HTMLSelectElement)) {
        throw new Error("Retained version picker did not render as a select");
      }
      expect(retainedVersionPicker.value).toBe(
        `${platformProjectId}/${projectVersionId}`,
      );
      expect(slot.getAllByRole("combobox", { name: "Project" })).toHaveLength(
        1,
      );
      expect(
        slot.inspection.rpcCalls.filter(
          (call) => call.method === "hbomReviewList",
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            input: expect.objectContaining({
              projectId: workspaceProjectId,
              projectVersionId: null,
            }),
          }),
        ]),
      );
      expect(requestedProjectIds).not.toContain(platformProjectId);
      expect(requestedProjectIds).toContain(workspaceProjectId);
      slot.lifecycle.unmount();
    } finally {
      await host.harness.lifecycle.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "refetches the registered panel only for its version through the real sync publisher",
    { timeout: 60_000 },
    async () => {
      const host = createFakePluginHost({
        pluginId: "finite-state-bom-realtime-boundary",
        sdk: {
          projects: {
            get: ({ projectId }) => ({ id: projectId, sources: [] }),
          },
        },
      });
      const state = createMockPlatformState(FIXTURE_ROOT);
      const mock = createMockRemote({
        platformToken: "fs176-token",
        assuranceStudioKey: "unused",
        fixtureRoot: FIXTURE_ROOT,
        register(service, registry) {
          if (service === "platform") registerPlatformHandlers(registry, state);
        },
      });
      const platform = new PlatformClient({
        baseUrl: "http://platform.mock",
        token: "fs176-token",
        fetch: mock.platform.fetch,
      });
      const assuranceStudio = new AssuranceStudioClient({
        baseUrl: "http://assurance-studio.mock",
        apiKey: "unused",
        fetch: mock.assuranceStudio.fetch,
      });

      try {
        const ctx = createPluginContext(host.bb);
        const services: RemoteServices = {
          platform,
          assuranceStudio,
          forgeCompute: null,
        };
        ctx.service<RemoteServices>("remote-services", () => services);
        registerBom(host.bb, ctx);
        registerSync(host.bb, ctx);

        const projectId = requiredId(
          [...state.projects.values()][0],
          "project fixture",
        );
        const versions = [...state.versions.values()];
        const activeVersionId = requiredId(
          versions.find((version) => version["priorVersionId"] !== null),
          "active version fixture",
        );
        const otherVersionId = requiredId(
          versions.find((version) => version["id"] !== activeVersionId),
          "other version fixture",
        );

        const app = await loadPluginApp(() => import("../../app.js"));
        const panel = app.navPanels.find(
          (candidate) => candidate.path === "bom",
        );
        if (!panel) throw new Error("BOM panel not registered");

        let firstPageReads = 0;
        const slot = renderSlot(
          panel,
          { subPath: "software" },
          {
            context: { projectId: "bb-project-fs176" },
            sidebarThreads: {
              status: "ready",
              projects: [
                {
                  id: "bb-project-fs176",
                  name: "FS-176",
                  isPersonal: false,
                },
              ],
            },
            rpc: {
              connectionsStatus: connectedRemoteStatus,
              bomCachedProjectVersions: () => ({
                versions: [
                  {
                    platformProjectId: projectId,
                    platformProjectName: "Eagle Connected Gateway",
                    projectVersionId: activeVersionId,
                    projectVersionName: "2.4.0",
                    asOf: null,
                    state: "empty" as const,
                  },
                ],
                selectedPlatformProjectId: projectId,
                selectedProjectVersionId: activeVersionId,
              }),
              async bomSoftwareList(input) {
                if (
                  typeof input === "object" &&
                  input !== null &&
                  Reflect.get(input, "continuation") === null
                ) {
                  firstPageReads += 1;
                }
                return host.harness.behavior.callRpc("bomSoftwareList", input);
              },
              bomComponentGet: (input) =>
                host.harness.behavior.callRpc("bomComponentGet", input),
              syncPull: (input) =>
                host.harness.behavior.callRpc("syncPull", input),
              firmwareMountsList: () => ({
                items: [],
                total: 0,
                next: null,
                cache: emptyCache,
              }),
            },
          },
        );

        await slot.findByText("No components in this view");
        expect(firstPageReads).toBe(1);

        const publishAndDeliver = async (
          projectVersionId: string,
        ): Promise<FakeRealtimeSignal[]> => {
          const signalCursor = host.harness.inspection.realtimeSignals.length;
          await host.harness.behavior.callRpc("syncPull", {
            workspaceProjectId: "bb-project-fs176",
            projectId,
            projectVersionId,
            kinds: ["sbomComponent"],
          });
          const published = host.harness.inspection.realtimeSignals
            .slice(signalCursor)
            .filter((signal) => signal.channel === "bom:changed");

          // Bridge only events captured from the registered backend publisher
          // into the registered app harness; no event or payload is synthesized.
          for (const signal of published) {
            await slot.behavior.emitRealtime(signal.channel, signal.payload);
          }
          return published;
        };

        const mismatching = await publishAndDeliver(otherVersionId);
        expect(mismatching).toEqual([
          {
            channel: "bom:changed",
            payload: { projectVersionId: otherVersionId },
          },
        ]);
        expect(firstPageReads).toBe(1);

        const matching = await publishAndDeliver(activeVersionId);
        expect(matching).toEqual([
          {
            channel: "bom:changed",
            payload: { projectVersionId: activeVersionId },
          },
        ]);
        await waitFor(() => expect(firstPageReads).toBe(2));
        expect(await slot.findByText("eagle-component-001")).toBeTruthy();
      } finally {
        platform.close();
        assuranceStudio.close();
        await mock.close();
        await host.harness.lifecycle.dispose();
      }
    },
  );
});
