import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";

import { createPluginContext } from "../../../../lib/context.js";
import {
  ASSURANCE_STUDIO_MAX_PAGE_SIZE,
  AssuranceStudioClient,
} from "../../../../lib/remote/assurance-studio/client.js";
import {
  registerMockAssuranceStudio,
} from "../../../../test/mock-remote/assurance-studio/register.js";
import {
  createMockRemote,
  type MockRemoteHarness,
} from "../../../../test/mock-remote/server.js";
import { pull } from "../../../sync/engine/pull.js";
import { BaseSnapshotStore } from "../../../sync/store/base-snapshot.js";
import type { AdapterSlugResolver } from "./adapters.js";
import { createCanvasEntityAdapters } from "./adapters.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../../../../test/mock-remote/fixtures", import.meta.url),
);
const API_KEY = "fs153-as-key";
const PROJECT_ID = "project-4a752600a07a";
const TARA_KINDS = [
  "component",
  "zone",
  "asset",
  "dataflow",
  "threat",
] as const;

const expectedCounts = {
  component: 12,
  zone: 3,
  asset: 4,
  dataflow: 11,
  threat: 16,
} as const;

let harness: MockRemoteHarness | null = null;
let host: ReturnType<typeof createFakePluginHost> | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  await host?.harness.lifecycle.dispose();
  host = null;
});

describe("canvas remote adapters", () => {
  it("pulls all five TARA kinds through the real AS client within its page cap", async () => {
    const requestedPageSizes: number[] = [];
    harness = createMockRemote({
      platformToken: "unused",
      assuranceStudioKey: API_KEY,
      fixtureRoot: FIXTURE_ROOT,
      register(service, registry) {
        if (service === "assurance-studio") {
          registerMockAssuranceStudio(registry, FIXTURE_ROOT);
        }
      },
    });
    const client = new AssuranceStudioClient({
      baseUrl: "http://assurance-studio.mock",
      apiKey: API_KEY,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET") {
          const pageSize = new URL(request.url).searchParams.get("limit");
          if (pageSize !== null) requestedPageSizes.push(Number(pageSize));
        }
        return harness!.assuranceStudio.fetch(request);
      },
    });

    requestedPageSizes.length = 0;
    const resolver: AdapterSlugResolver = {
      remoteToSlug: () => null,
      slugToRemote: () => null,
    };
    const scope = { projectId: PROJECT_ID, projectVersionId: null };
    const adapters = createCanvasEntityAdapters(client, resolver);
    host = createFakePluginHost({ pluginId: "finite-state-fs153-adapter-pull" });
    const db = createPluginContext(host.bb).db();
    const report = await pull({
      db,
      adapters,
      worktreeRoot: null,
      createGenerationId: () => "generation-fs153",
      now: () => new Date("2026-08-13T18:00:00.000Z"),
    }, scope, [...TARA_KINDS]);

    expect(report.kinds).toEqual(Object.fromEntries(
      TARA_KINDS.map((kind) => [kind, {
        fetched: expectedCounts[kind],
        baseRows: expectedCounts[kind],
      }]),
    ));
    const snapshots = new BaseSnapshotStore(db);
    for (const kind of TARA_KINDS) {
      const accepted = snapshots.listAccepted(PROJECT_ID, "@project", kind);
      expect(accepted).toHaveLength(expectedCounts[kind]);
      for (const row of accepted) {
        expect(row.payload).toMatchObject({
          slug: expect.stringMatching(new RegExp(`^${kind}-[0-9a-f]{20}$`, "u")),
        });
      }
    }
    expect(requestedPageSizes).toEqual(
      TARA_KINDS.map(() => ASSURANCE_STUDIO_MAX_PAGE_SIZE),
    );
    expect(requestedPageSizes.every(
      (pageSize) => pageSize <= ASSURANCE_STUDIO_MAX_PAGE_SIZE,
    )).toBe(true);
  });
});
