import { resolve } from "node:path";

import {
  createFakePluginHost,
  makeThreadResponse,
} from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginContext } from "../../lib/context.js";
import { registerRemoteServices } from "../../lanes/remote/register.js";
import { registerSync } from "../../lanes/sync/register.js";
import { registerMockAssuranceStudio } from "./assurance-studio/register.js";
import { registerPlatformHandlers } from "./platform/register.js";
import { createMockPlatformState } from "./platform/state.js";
import { createMockRemote, type MockRemoteHarness } from "./server.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "fixtures");
const PLATFORM_TOKEN = "controller-path-platform-token";
const AS_KEY = "controller-path-as-key";

const harnesses: MockRemoteHarness[] = [];
const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

function authHeaders(token: string): HeadersInit {
  return { "X-Authorization": token };
}

describe("controller-path configuration against the listening seeded mock", () => {
  it("returns a validator-compliant /api Platform listen URL and serves both mounts over real HTTP", async () => {
    const state = createMockPlatformState(FIXTURE_ROOT);
    const harness = createMockRemote({
      platformToken: PLATFORM_TOKEN,
      assuranceStudioKey: AS_KEY,
      fixtureRoot: FIXTURE_ROOT,
      register(service, registry) {
        if (service === "platform") registerPlatformHandlers(registry, state);
        else registerMockAssuranceStudio(registry, FIXTURE_ROOT);
      },
    });
    harnesses.push(harness);

    const urls = await harness.listen();
    expect(urls.platformBaseUrl.endsWith("/api")).toBe(true);
    expect(urls.assuranceStudioBaseUrl.endsWith("/api")).toBe(false);

    const origin = urls.platformBaseUrl.replace(/\/api$/u, "");
    const bare = await fetch(`${origin}/public/v0/projects`, {
      headers: authHeaders(PLATFORM_TOKEN),
    });
    const prefixed = await fetch(`${urls.platformBaseUrl}/public/v0/projects`, {
      headers: authHeaders(PLATFORM_TOKEN),
    });
    expect(bare.status).toBe(200);
    expect(prefixed.status).toBe(200);
    expect(await bare.json()).toEqual(await prefixed.json());
  });

  it("drives settings -> controller -> validator -> real HTTP health against the seeded mock", async () => {
    const state = createMockPlatformState(FIXTURE_ROOT);
    const harness = createMockRemote({
      platformToken: PLATFORM_TOKEN,
      assuranceStudioKey: AS_KEY,
      fixtureRoot: FIXTURE_ROOT,
      register(service, registry) {
        if (service === "platform") registerPlatformHandlers(registry, state);
        else registerMockAssuranceStudio(registry, FIXTURE_ROOT);
      },
    });
    harnesses.push(harness);
    const urls = await harness.listen();

    const host = createFakePluginHost({
      pluginId: "finite-state-controller-path-happy",
    });
    hosts.push(host);
    await registerRemoteServices(host.bb, createPluginContext(host.bb));
    await host.harness.setSettings({
      platformBaseUrl: urls.platformBaseUrl,
      platformToken: PLATFORM_TOKEN,
    });

    await vi.waitFor(async () => {
      await expect(
        host.harness.callRpc("connectionsStatus"),
      ).resolves.toMatchObject({
        platform: { state: "connected" },
      });
    });

    await expect(
      host.harness.callRpc("remoteConnectionSelfDiagnosis"),
    ).resolves.toMatchObject({
      platform: { state: "ok" },
    });
  });

  it("surfaces the controller slot diagnostic through the CLI unavailable-error path", async () => {
    const host = createFakePluginHost({
      pluginId: "finite-state-controller-path-cli-shape",
    });
    hosts.push(host);
    const context = createPluginContext(host.bb);
    await registerRemoteServices(host.bb, context);
    registerSync(host.bb, context);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({
        id: "thread-controller-path",
        projectId: "bb-project-controller-path",
        environmentId: "environment-controller-path",
      }),
    );
    host.harness.sdk.stub("environments.get", async () => ({
      id: "environment-controller-path",
      projectId: "bb-project-controller-path",
      hostId: "host-controller-path",
      path: "/tmp/fs-controller-path",
    }));

    await host.harness.setSettings({
      platformBaseUrl: "https://platform.example",
      platformToken: "token-is-set",
    });

    await vi.waitFor(async () => {
      await expect(
        host.harness.callRpc("remoteConnectionSelfDiagnosis"),
      ).resolves.toMatchObject({
        platform: {
          state: "invalid-settings",
          message: expect.stringContaining("must end with /api"),
        },
      });
    });

    const result = await host.harness.behavior.runCli(
      ["finite-state", "as-projects"],
      {
        cwd: "/untrusted",
        threadId: "thread-controller-path",
        projectId: "bb-project-controller-path",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Platform URL (platformBaseUrl) must end with /api because Platform routes omit that prefix.",
    );
    expect(result.stderr).toContain(
      "code=REMOTE_UNAVAILABLE service=platform status=none",
    );
    expect(result.stderr).not.toMatch(
      /Platform is not configured\. Set Platform URL/u,
    );
  });
});
