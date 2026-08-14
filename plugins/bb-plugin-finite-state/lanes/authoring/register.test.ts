import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginContext } from "../../lib/context.js";
import plugin from "../../server.js";
import { RPC_WIRE_METHODS } from "../../shared/contract.js";
import type { RpcMethod } from "../../shared/contract.js";
import type { KicadCapability } from "../hardware/extract/driver.js";
import { registerHardware } from "../hardware/register.js";
import { buildLogPath, buildLogRoot } from "./build/logs.js";
import {
  createBuildRun,
  getBuildRun,
  listBuildRuns,
} from "./build/runs-store.js";
import { registerAuthoring } from "./register.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

const PENDING_FROZEN_RPC_METHODS = [
  "workspaceSummary", // WP-03: foundation workspace summary.
  "triageRunGet", // WP-28: persisted policy run reports.
  "triageDecisionWrite", // WP-26: single local triage decisions.
  "triageDecisionBulkWrite", // WP-26: bulk local triage decisions.
  "triagePolicyPreview", // WP-28: policy dry-run reports.
  "triagePolicyApply", // WP-28: policy application.
  "taraGet", // WP-32: self-fetching TARA inspector detail.
  "reviewTransition", // WP-40: human review lifecycle transitions.
  "documentsList", // WP-56: Documents store and viewer.
  "documentsGet", // WP-56: Documents store and viewer.
  "documentsSearch", // WP-56: Documents store and viewer.
  "documentsMetadataUpdate", // WP-56: Documents store and viewer.
  "documentsExtractionsList", // WP-56: Documents store and viewer.
  "groundingSourcesList", // WP-82: Grounding store and document index.
  "groundingQuery", // WP-82: Grounding store and document index.
  "groundingCoverageGet", // WP-82: Grounding store and document index.
] as const satisfies readonly RpcMethod[];

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

describe("authoring registration", () => {
  it("narrows probe history to zero, wires local-auth logs, and recovers queued rows", async () => {
    const host = createFakePluginHost({
      pluginId: `fs-authoring-register-${crypto.randomUUID()}`,
    });
    hosts.push(host);
    const ctx = createPluginContext(host.bb);
    const db = ctx.db();
    const logPath = await buildLogPath(db, "build-queued");
    await writeFile(logPath, "prior evidence\n", "utf8");
    await createBuildRun(
      { db, publish: () => undefined },
      {
        projectId: "project-a",
        projectVersionId: "version-a",
        runId: "build-queued",
        kind: "build",
        target: null,
        toolchain: "fixture",
        artifact: null,
        digest: null,
        logPath,
        startedAt: "2026-08-13T12:00:00.000Z",
      },
    );

    const registration = registerAuthoring(host.bb, ctx, {
      toolchains: {
        path: await buildLogRoot(db),
        probes: [
          {
            id: "fixture-missing-compiler",
            binary: "fixture-missing-compiler",
            versionArgs: ["--version"],
            unlocks: "build",
            parse: () => null,
          },
          {
            id: "fixture-missing-west",
            binary: "fixture-missing-west",
            versionArgs: ["--version"],
            unlocks: "zephyr-workspace",
            parse: () => null,
          },
        ],
        probeTimeoutMs: 50,
      },
    });
    const service = host.harness.behavior.runService(
      "authoring-build-supervisor",
    );
    await registration.ready;

    expect(host.harness.inspection.registrations.httpRoutes).toContainEqual(
      expect.objectContaining({
        method: "GET",
        path: "/authoring/build/log",
        auth: "local",
      }),
    );
    expect(logPath.startsWith(`${await buildLogRoot(db)}/`)).toBe(true);

    const probes = listBuildRuns(db, {
      projectId: "project-a",
      projectVersionId: "version-a",
      pageSize: 50,
      cursor: null,
      kinds: ["probe"],
      statuses: [],
    });
    expect(probes).toEqual({ items: [], total: 0, cursor: null });

    expect(
      getBuildRun(
        db,
        { projectId: "project-a", projectVersionId: "version-a" },
        "build-queued",
      )?.status,
    ).toBe("failed");
    expect(await readFile(logPath, "utf8")).toContain(
      "orphaned: plugin restarted while the job was queued",
    );

    const response = await host.harness.behavior.fetchHttp(
      "GET",
      "/authoring/build/log?projectId=project-a&projectVersionId=version-a&runId=build-queued",
      { headers: { Range: "bytes=0-4" } },
    );
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("prior");

    expect(host.harness.inspection.needsConfigurationMessages).toEqual([]);
    await expect(
      host.harness.behavior.callRpc("authoringToolchainStatus", null),
    ).resolves.toEqual(
      expect.objectContaining({
        state: "unavailable",
        configured: false,
        missing: [
          { id: "fixture-missing-compiler", unlocks: "build" },
          { id: "fixture-missing-west", unlocks: "zephyr-workspace" },
        ],
        message: expect.stringContaining(
          "build missing fixture-missing-compiler; zephyr-workspace missing fixture-missing-west",
        ),
      }),
    );
    expect(host.harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message: expect.stringContaining(
        "Authoring toolchain advisory: build missing fixture-missing-compiler; zephyr-workspace missing fixture-missing-west",
      ),
    });
    service.controller.abort();
    await service.done;
  });

  it("registers every non-pending frozen RPC method exactly once through the real plugin", async () => {
    const host = createFakePluginHost({
      pluginId: `finite-state-full-${crypto.randomUUID()}`,
    });
    hosts.push(host);

    await expect(plugin(host.bb)).resolves.toBeUndefined();

    const registeredMethods = host.harness.inspection.registrations.rpcMethods;
    expect(
      new Set(registeredMethods).size,
      "every production RPC, including lane-local additive methods, must be registered once",
    ).toBe(registeredMethods.length);

    const registrationCounts = new Map<string, number>();
    for (const registeredMethod of registeredMethods) {
      registrationCounts.set(
        registeredMethod,
        (registrationCounts.get(registeredMethod) ?? 0) + 1,
      );
    }
    const pendingMethods: ReadonlySet<RpcMethod> = new Set(
      PENDING_FROZEN_RPC_METHODS,
    );
    const allowlistedButRegistered = PENDING_FROZEN_RPC_METHODS.filter(
      (wireMethod) => (registrationCounts.get(wireMethod) ?? 0) !== 0,
    );
    const unallowlistedWithoutExactlyOne = Object.values(RPC_WIRE_METHODS)
      .filter(
        (wireMethod) =>
          !pendingMethods.has(wireMethod) &&
          (registrationCounts.get(wireMethod) ?? 0) !== 1,
      )
      .map((wireMethod) => ({
        wireMethod,
        registrations: registrationCounts.get(wireMethod) ?? 0,
      }));

    expect(
      allowlistedButRegistered,
      "remove newly registered methods from PENDING_FROZEN_RPC_METHODS",
    ).toEqual([]);
    expect(
      unallowlistedWithoutExactlyOne,
      "every non-pending frozen method must resolve to exactly one production handler",
    ).toEqual([]);
    expect(
      registeredMethods.filter(
        (registered) => registered === RPC_WIRE_METHODS["benchDev.runs.list"],
      ),
    ).toHaveLength(1);
  });

  it("ignores an absent-KiCad capability result that resolves after disposal", async () => {
    let resolveCapability: ((value: KicadCapability) => void) | undefined;
    const host = createFakePluginHost({
      pluginId: `finite-state-disposed-${crypto.randomUUID()}`,
    });
    hosts.push(host);
    const ctx = createPluginContext(host.bb);
    ctx.service(
      "hardware.kicad-capability",
      () =>
        new Promise<KicadCapability>((resolve) => {
          resolveCapability = resolve;
        }),
    );
    const needsConfiguration = vi.spyOn(host.bb.status, "needsConfiguration");
    const unhandledRejections: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", recordUnhandled);

    try {
      registerHardware(host.bb, ctx);
      expect(resolveCapability).toBeDefined();

      await host.harness.lifecycle.dispose();
      resolveCapability?.({
        installed: false,
        cliPath: null,
        version: null,
        supported: false,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(needsConfiguration).not.toHaveBeenCalled();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }
  });
});
