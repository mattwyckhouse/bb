import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginContext } from "../../lib/context.js";
import { createBenchCommandServices, registerBench } from "./register.js";
import { createBenchTestStore, evidenceBundle } from "./store/test-helpers.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
});

describe("bench registration", () => {
  it("registers frozen RPCs, bounded stream seams, and one job service without a CLI", async () => {
    const host = createFakePluginHost({ pluginId: "finite-state-bench-registration" });
    hosts.push(host);
    registerBench(host.bb, createPluginContext(host.bb));

    const page = await host.harness.behavior.callRpc("benchRunsList", {
      projectId: "project-a",
      projectVersionId: "version-a",
      pageSize: 20,
      continuation: null,
    });
    expect(page).toMatchObject({ items: [], total: 0, next: null });
    await expect(
      host.harness.behavior.callRpc("benchRunStart", {
        projectId: "project-a",
        projectVersionId: "version-a",
        tier: "tier0",
        hostId: "host-a",
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("NOT_IMPLEMENTED") });
    const response = await host.harness.behavior.fetchHttp("GET", "/bench/runs/artifact");
    expect(response.status).toBe(501);
    expect(host.harness.registrations.cli).toBeNull();

    const service = host.harness.behavior.runService("bench-jobs");
    service.controller.abort();
    await service.done;
  });

  it("publishes only a post-commit tiny refetch hint and suppresses idempotent hints", () => {
    const fixture = createBenchTestStore("registration-realtime");
    hosts.push(fixture.host);
    const services = createBenchCommandServices(fixture.host.bb, fixture.db);
    services.storeEvidenceCheckpoint(evidenceBundle());
    services.storeEvidenceCheckpoint(evidenceBundle());
    expect(fixture.host.harness.realtimeSignals).toEqual([
      { channel: "bench:changed", payload: { runId: "run-a", status: "completed" } },
    ]);
    expect(
      fixture.db.prepare("SELECT synced_at FROM verification_runs").pluck().get(),
    ).not.toBeNull();
  });
});
