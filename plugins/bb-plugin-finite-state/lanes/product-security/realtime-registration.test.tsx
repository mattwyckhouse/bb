// @vitest-environment jsdom

import { resolve } from "node:path";

import { cleanup, configure, waitFor } from "@testing-library/react";
import {
  createFakePluginHost,
  type FakeRealtimeSignal,
} from "@bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createPluginContext } from "../../lib/context.js";
import { AssuranceStudioClient } from "../../lib/remote/assurance-studio/client.js";
import { PlatformClient } from "../../lib/remote/platform/client.js";
import type { RemoteServices } from "../../lib/remote/types.js";
import { connectedRemoteStatus } from "../../test/app-connections.js";
import { registerPlatformHandlers } from "../../test/mock-remote/platform/register.js";
import { createMockPlatformState } from "../../test/mock-remote/platform/state.js";
import { createMockRemote } from "../../test/mock-remote/server.js";
import { registerAdapter, type EntityAdapter } from "../sync/engine/adapter.js";
import { registerSync } from "../sync/register.js";
import { createSerializer } from "../sync/serialize/serializer.js";

const FIXTURE_ROOT = resolve(
  import.meta.dirname,
  "../../test/mock-remote/fixtures",
);
const PROJECT_ID = "project-realtime";
const ACTIVE_VERSION_ID = "version-active";
const OTHER_VERSION_ID = "version-other";

const cache = {
  state: "fresh" as const,
  asOf: "2026-08-14T12:00:00.000Z",
  message: null,
  acceptedGenerationId: "generation-1",
  baseRevision: 1,
};

class SurfaceResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    queueMicrotask(() => {
      const size = { blockSize: 600, inlineSize: 1000 };
      this.callback(
        [
          {
            target,
            contentRect: new DOMRectReadOnly(0, 0, 1000, 600),
            borderBoxSize: [size],
            contentBoxSize: [size],
            devicePixelContentBoxSize: [size],
          },
        ],
        this,
      );
    });
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  configure({ asyncUtilTimeout: 10_000 });
  vi.stubGlobal("ResizeObserver", SurfaceResizeObserver);
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      readonly m22 = 1;
    },
  );
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => true,
    }),
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback): number =>
      window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    window.clearTimeout(handle);
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 600),
  );
  Object.defineProperties(HTMLElement.prototype, {
    offsetWidth: { configurable: true, get: () => 1000 },
    offsetHeight: { configurable: true, get: () => 600 },
  });
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => new DOMRect(0, 0, 80, 16),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function adapter(kind: "requirement" | "threat"): EntityAdapter {
  return {
    kind,
    klass: "VERSIONED",
    serializer: createSerializer(kind),
    async *fetchRemote(scope) {
      yield [
        {
          key: `${kind}-1`,
          remoteId: `${kind}-remote-1`,
          payload: {
            id: `${kind}-remote-1`,
            projectId: scope.projectId,
            kind,
            fields: { id: `${kind}-1`, title: `${kind} one` },
            humanEdited: null,
            reviewStatus: null,
            reviewVersion: null,
          },
        },
      ];
    },
    async readWorking() {
      return [];
    },
  };
}

function requirementPage() {
  return {
    items: [
      {
        projectId: PROJECT_ID,
        projectVersionId: ACTIVE_VERSION_ID,
        kind: "requirement",
        key: "REQ-1",
        label: "REQ-1",
        fields: {
          requirement: {
            schema: "fs-requirement/v1",
            id: "REQ-1",
            req_type: "security",
            priority: "P1",
            status: "draft",
            ears: {
              pattern: "ubiquitous",
              text: "The gateway SHALL reject unsigned firmware",
              parts: {
                system: "gateway",
                response: "reject unsigned firmware",
              },
            },
            source_description: "Protect updates.",
            mitigations: [],
            controls: [],
            standards: [],
            verification: [],
          },
          evidenceState: "not_run",
          stale: false,
          local: false,
          tiers: [
            { tier: "static", state: "not_run", count: 0 },
            { tier: "emulation", state: "not_run", count: 0 },
            { tier: "hil", state: "not_run", count: 0 },
            { tier: "manual", state: "not_run", count: 0 },
          ],
          sourceSha256: null,
        },
      },
    ],
    total: 1,
    next: null,
    cache,
  };
}

function taraPage(input: unknown) {
  const kind =
    typeof input === "object" && input !== null
      ? Reflect.get(input, "kind")
      : null;
  return {
    items:
      kind === "component"
        ? [
            {
              projectId: PROJECT_ID,
              projectVersionId: ACTIVE_VERSION_ID,
              kind: "component",
              key: "COMP-1",
              label: "Gateway",
              fields: { type: "device" },
            },
          ]
        : [],
    total: kind === "component" ? 1 : 0,
    next: null,
    cache,
  };
}

function threatSnapshot() {
  return {
    projectVersionId: ACTIVE_VERSION_ID,
    revision:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    threats: [],
    aggregates: [],
    methodology: {
      configured: false,
      labels: {
        spoofing: "Spoofing",
        tampering: "Tampering",
        repudiation: "Repudiation",
        information_disclosure: "Information disclosure",
        denial_of_service: "Denial of service",
        elevation_of_privilege: "Elevation of privilege",
      },
    },
    total: 0,
    truncated: false,
    partialError: null,
    cache: { state: "fresh" as const, asOf: cache.asOf, message: null },
  };
}

describe("registered product-security realtime boundary", () => {
  it(
    "refetches requirement and threat subscribers only for their version through the real sync publisher",
    { timeout: 60_000 },
    async () => {
      const host = createFakePluginHost({
        pluginId: "finite-state-product-security-realtime-boundary",
      });
      const remoteState = createMockPlatformState(FIXTURE_ROOT);
      const mock = createMockRemote({
        platformToken: "fs179-token",
        assuranceStudioKey: "unused",
        fixtureRoot: FIXTURE_ROOT,
        register(service, registry) {
          if (service === "platform") {
            registerPlatformHandlers(registry, remoteState);
          }
        },
      });
      const platform = new PlatformClient({
        baseUrl: "http://platform.mock",
        token: "fs179-token",
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
        registerAdapter(adapter("requirement"));
        registerAdapter(adapter("threat"));
        registerSync(host.bb, ctx);

        const app = await loadPluginApp(() => import("../../app.js"));
        const panel = app.navPanels.find(
          (candidate) => candidate.id === "product-security",
        );
        if (!panel) throw new Error("Product Security panel not registered");

        const publishAndDeliver = async (
          slot: ReturnType<typeof renderSlot>,
          kind: "requirement" | "threat",
          projectVersionId: string,
          channel: "requirements:changed" | "tara:changed",
        ): Promise<FakeRealtimeSignal[]> => {
          const cursor = host.harness.inspection.realtimeSignals.length;
          await host.harness.behavior.callRpc("syncPull", {
            projectId: PROJECT_ID,
            projectVersionId,
            kinds: [kind],
          });
          const published = host.harness.inspection.realtimeSignals
            .slice(cursor)
            .filter((signal) => signal.channel === channel);
          for (const signal of published) {
            await slot.behavior.emitRealtime(signal.channel, signal.payload);
          }
          return published;
        };

        let requirementReads = 0;
        const requirements = renderSlot(
          panel,
          { subPath: "requirements" },
          {
            context: { projectId: PROJECT_ID, threadId: null },
            rpc: {
              connectionsStatus: connectedRemoteStatus,
              requirementsList: () => {
                requirementReads += 1;
                return requirementPage();
              },
            },
          },
        );
        await requirements.findByText("REQ-1");
        expect(requirementReads).toBe(1);
        expect(
          await publishAndDeliver(
            requirements,
            "requirement",
            OTHER_VERSION_ID,
            "requirements:changed",
          ),
        ).toEqual([
          {
            channel: "requirements:changed",
            payload: {
              projectId: PROJECT_ID,
              projectVersionId: OTHER_VERSION_ID,
            },
          },
        ]);
        expect(requirementReads).toBe(1);
        await publishAndDeliver(
          requirements,
          "requirement",
          ACTIVE_VERSION_ID,
          "requirements:changed",
        );
        await waitFor(() => expect(requirementReads).toBe(2));
        requirements.lifecycle.unmount();

        let threatReads = 0;
        const threats = renderSlot(
          panel,
          { subPath: "tara" },
          {
            context: { projectId: PROJECT_ID, threadId: null },
            rpc: {
              connectionsStatus: connectedRemoteStatus,
              taraList: taraPage,
              threatOverlaySnapshot: () => {
                threatReads += 1;
                return threatSnapshot();
              },
            },
          },
        );
        await threats.findByLabelText("component Gateway");
        await waitFor(() => expect(threatReads).toBe(1));
        expect(
          await publishAndDeliver(
            threats,
            "threat",
            OTHER_VERSION_ID,
            "tara:changed",
          ),
        ).toEqual([
          {
            channel: "tara:changed",
            payload: {
              projectId: PROJECT_ID,
              projectVersionId: OTHER_VERSION_ID,
            },
          },
        ]);
        expect(threatReads).toBe(1);
        await publishAndDeliver(
          threats,
          "threat",
          ACTIVE_VERSION_ID,
          "tara:changed",
        );
        await waitFor(() => expect(threatReads).toBe(2));
        threats.lifecycle.unmount();
      } finally {
        platform.close();
        assuranceStudio.close();
        await mock.close();
        await host.harness.lifecycle.dispose();
      }
    },
  );
});
