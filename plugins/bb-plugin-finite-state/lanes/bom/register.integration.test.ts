import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { createPluginContext } from "../../lib/context.js";
import { AssuranceStudioClient } from "../../lib/remote/assurance-studio/client.js";
import { PlatformClient } from "../../lib/remote/platform/client.js";
import type { RemoteServices } from "../../lib/remote/types.js";
import { createMockPlatformState } from "../../test/mock-remote/platform/state.js";
import { registerPlatformHandlers } from "../../test/mock-remote/platform/register.js";
import { createMockRemote } from "../../test/mock-remote/server.js";
import { registerSyncCli } from "../sync/cli.js";
import { bomAppRpcContract } from "./rpc.js";
import { registerBom } from "./register.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../test/mock-remote/fixtures");

function requiredId(row: Record<string, unknown> | undefined, label: string): string {
  const id = row?.["id"];
  if (typeof id !== "string" || id.length === 0) throw new Error(`${label} has no id`);
  return id;
}

describe("registered SBOM pull surfaces", () => {
  it("pulls through the registered CLI and serves landed rows through the registered RPC", async () => {
    const host = createFakePluginHost({ pluginId: "finite-state-sbom-registered" });
    const root = await mkdtemp(join(tmpdir(), "fs-sbom-registered-"));
    const state = createMockPlatformState(FIXTURE_ROOT);
    const mock = createMockRemote({
      platformToken: "fs172-token",
      assuranceStudioKey: "unused",
      fixtureRoot: FIXTURE_ROOT,
      register(service, registry) {
        if (service === "platform") registerPlatformHandlers(registry, state);
      },
    });
    const platform = new PlatformClient({
      baseUrl: "http://platform.mock",
      token: "fs172-token",
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
      registerSyncCli(
        host.bb,
        { db: ctx.db(), worktreeRoot: null },
        platform,
        async () => root,
      );

      const projectId = requiredId([...state.projects.values()][0], "project fixture");
      const projectVersionId = requiredId([...state.versions.values()][0], "version fixture");
      const pulled = await host.harness.behavior.runCli([
        "finite-state",
        "pull",
        "sbomComponent",
        "--project",
        projectId,
        "--version",
        projectVersionId,
        "--json",
      ], { projectId: "bb-project-fs172", threadId: "thread-fs172" });

      expect(pulled).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(pulled.stdout)).toMatchObject({
        kinds: { sbomComponent: { fetched: 0, baseRows: 0 } },
      });
      expect(ctx.db().prepare(
        `SELECT COUNT(*)
           FROM sbom_components
          WHERE project_id = ? AND project_version_id = ?`,
      ).pluck().get(projectId, projectVersionId)).toBeGreaterThan(0);

      const page = bomAppRpcContract.bomSoftwareList.output.parse(
        await host.harness.behavior.callRpc("bomSoftwareList", {
          projectId,
          projectVersionId,
          pageSize: 100,
          continuation: null,
          filters: {},
        }),
      );
      expect(page).toMatchObject({
        total: expect.any(Number),
        cache: { state: "fresh" },
      });
      expect(page.items.length).toBeGreaterThan(0);
    } finally {
      platform.close();
      assuranceStudio.close();
      await mock.close();
      await host.harness.lifecycle.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
