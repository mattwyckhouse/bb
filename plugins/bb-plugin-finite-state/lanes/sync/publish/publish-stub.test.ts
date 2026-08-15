import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { createPluginContext } from "../../../lib/context.js";
import { AssuranceStudioClient } from "../../../lib/remote/assurance-studio/client.js";
import { PlatformClient } from "../../../lib/remote/platform/client.js";
import { registerAgentic } from "../../agentic/register.js";
import { registerSyncCli } from "../cli.js";
import { publishStub } from "./publish-stub.js";

describe("Platform Graph publish stub", () => {
  it("reports the exact unavailable destination and AUTHORITY decision", () => {
    expect(publishStub()).toEqual({
      target: "platform-graph",
      status: "unavailable-stub",
      message: expect.stringMatching(
        /future Platform Graph.*Platform does not yet host TARA entities.*Nothing was sent.*AUTHORITY — Git SoR, Platform Graph & AS Seed\.md/u,
      ),
    });
  });

  it("runs through the registered CLI with zero remote, worktree, or projection writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "fs-publish-stub-"));
    const host = createFakePluginHost({
      pluginId: "finite-state-publish-stub",
    });
    const context = createPluginContext(host.bb);
    let remoteCalls = 0;
    let worktreeResolutions = 0;
    let interceptedCalls = 0;
    const guardedFetch: typeof fetch = async () => {
      remoteCalls += 1;
      throw new Error("publish stub attempted a remote call");
    };
    const platform = new PlatformClient({
      baseUrl: "http://platform.invalid",
      token: "unused",
      fetch: guardedFetch,
    });
    const assuranceStudio = new AssuranceStudioClient({
      baseUrl: "http://assurance-studio.invalid",
      apiKey: "unused",
      fetch: guardedFetch,
    });

    try {
      const db = context.db();
      const changesBefore = db
        .prepare<[], { count: number }>("SELECT total_changes() AS count")
        .get()!.count;
      registerSyncCli(
        host.bb,
        { db, worktreeRoot: null },
        platform,
        assuranceStudio,
        async () => {
          worktreeResolutions += 1;
          return {
            worktreeRoot: root,
            workspaceProjectId: "workspace-publish-stub",
          };
        },
        {},
        {
          commands: [{ name: "status", summary: "status", usage: "status" }],
          intercept: async () => {
            interceptedCalls += 1;
            throw new Error("publish stub entered the agentic dispatcher");
          },
        },
      );

      expect(
        host.harness.inspection.registrations.cli?.commands.find(
          (command) => command.name === "publish",
        ),
      ).toMatchObject({
        summary: expect.stringContaining("Human-only unavailable stub"),
        usage: "publish [--json]",
      });

      const result = await host.harness.behavior.runCli(["publish", "--json"]);
      expect(result).toMatchObject({ exitCode: 3, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual(publishStub());
      expect(remoteCalls).toBe(0);
      expect(worktreeResolutions).toBe(0);
      expect(interceptedCalls).toBe(0);
      expect(host.harness.inspection.sdk.calls).toEqual([]);
      expect(host.harness.realtimeSignals).toEqual([]);
      expect(await readdir(root)).toEqual([]);
      expect(
        db
          .prepare<[], { count: number }>("SELECT total_changes() AS count")
          .get()!.count,
      ).toBe(changesBefore);
    } finally {
      platform.close();
      assuranceStudio.close();
      await host.harness.lifecycle.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is absent from the real native agent registration surface", async () => {
    const host = createFakePluginHost({
      pluginId: "finite-state-publish-agent-guard",
    });
    try {
      registerAgentic(host.bb, createPluginContext(host.bb));
      const registered = host.harness.inspection.registrations.agentTools.map(
        (tool) => tool.name,
      );
      expect(registered.some((name) => /publish/iu.test(name))).toBe(false);
      expect(registered).not.toContain("fs_sync_publish");
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});
