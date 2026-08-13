import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createFakePluginHost,
  makeThreadResponse,
} from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginContext } from "../../../../lib/context.js";
import {
  ASSURANCE_STUDIO_MAX_PAGE_SIZE,
  AssuranceStudioClient,
} from "../../../../lib/remote/assurance-studio/client.js";
import { PlatformClient } from "../../../../lib/remote/platform/client.js";
import type {
  AsEntity,
  AsEntityKind,
  Json,
  RemoteServices,
} from "../../../../lib/remote/types.js";
import {
  registerMockAssuranceStudio,
} from "../../../../test/mock-remote/assurance-studio/register.js";
import {
  registerPlatformHandlers,
} from "../../../../test/mock-remote/platform/register.js";
import {
  createMockPlatformState,
} from "../../../../test/mock-remote/platform/state.js";
import {
  createMockRemote,
  type MockRemoteHarness,
} from "../../../../test/mock-remote/server.js";
import { registerSync } from "../../../sync/register.js";
import { BaseSnapshotStore } from "../../../sync/store/base-snapshot.js";
import { IdMapStore } from "../../../sync/store/id-map.js";
import { registerProductSecurity } from "../../register.js";
import {
  projectRemoteEntity,
  TARA_REMOTE_REQUIRED_FIELD_GROUPS,
  type AdapterSlugResolver,
} from "./adapters.js";

const FIXTURE_ROOT = fileURLToPath(
  new URL("../../../../test/mock-remote/fixtures", import.meta.url),
);
const API_KEY = "fs166-as-key";
const PLATFORM_TOKEN = "fs166-platform-token";
const PROJECT_ID = "project-4a752600a07a";
const VERSION_ID = "pv-a481df87dadf";
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

const corruptionFields = {
  component: "component_type",
  zone: "trust_level",
  asset: "criticality",
  dataflow: "data_types",
  threat: "stride_categories",
} as const;

let harness: MockRemoteHarness | null = null;
let host: ReturnType<typeof createFakePluginHost> | null = null;
let worktreeRoot: string | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  await host?.harness.lifecycle.dispose();
  host = null;
  if (worktreeRoot) await rm(worktreeRoot, { recursive: true, force: true });
  worktreeRoot = null;
});

function collectionKind(pathname: string): (typeof TARA_KINDS)[number] | null {
  const segment = pathname.split("/").at(-1);
  if (segment === "components") return "component";
  if (segment === "zones") return "zone";
  if (segment === "assets") return "asset";
  if (segment === "data-flows") return "dataflow";
  if (segment === "threats") return "threat";
  return null;
}

async function corruptRequiredField(
  request: Request,
  response: Response,
): Promise<Response> {
  const kind = request.method === "GET"
    ? collectionKind(new URL(request.url).pathname)
    : null;
  if (kind === null || !response.ok) return response;
  const body = await response.json() as {
    data?: { items?: Array<Record<string, Json>> };
  };
  for (const item of body.data?.items ?? []) {
    delete item[corruptionFields[kind]];
  }
  return Response.json(body, { status: response.status });
}

async function listAll(
  client: AssuranceStudioClient,
  kind: AsEntityKind,
): Promise<AsEntity[]> {
  const entities: AsEntity[] = [];
  for await (const page of client.listEntities(kind, {
    projectId: PROJECT_ID,
    page: { pageSize: 50 },
  })) entities.push(...page.items);
  return entities;
}

const derivedResolver: AdapterSlugResolver = {
  remoteToSlug: () => null,
  slugToRemote: () => null,
};

describe("canvas real-wire adapter contract", () => {
  it("publishes the default registered pull from committed fixtures atomically without identity drift", async () => {
    let corrupt = false;
    const requestedPageSizes: number[] = [];
    const platformState = createMockPlatformState(FIXTURE_ROOT);
    harness = createMockRemote({
      platformToken: PLATFORM_TOKEN,
      assuranceStudioKey: API_KEY,
      fixtureRoot: FIXTURE_ROOT,
      register(service, registry) {
        if (service === "platform") {
          registerPlatformHandlers(registry, platformState);
        } else {
          registerMockAssuranceStudio(registry, FIXTURE_ROOT);
        }
      },
    });
    const assuranceStudio = new AssuranceStudioClient({
      baseUrl: "http://assurance-studio.mock",
      apiKey: API_KEY,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "GET" && collectionKind(new URL(request.url).pathname)) {
          const pageSize = new URL(request.url).searchParams.get("limit");
          if (pageSize !== null) requestedPageSizes.push(Number(pageSize));
        }
        const response = await harness!.assuranceStudio.fetch(request);
        return corrupt ? corruptRequiredField(request, response) : response;
      },
    });
    const platform = new PlatformClient({
      baseUrl: "http://platform.mock",
      token: PLATFORM_TOKEN,
      fetch: harness.platform.fetch,
    });
    host = createFakePluginHost({ pluginId: "finite-state-fs166-registered-pull" });
    const context = createPluginContext(host.bb);
    const services: RemoteServices = {
      platform,
      assuranceStudio,
      forgeCompute: null,
    };
    context.service<RemoteServices>("remote-services", () => services);
    context.service("firmware.cli", () => ({
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    context.service("bench.cli", () => ({
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }));
    registerSync(host.bb, context);
    registerProductSecurity(host.bb, context);

    worktreeRoot = await mkdtemp(join(tmpdir(), "fs166-registered-pull-"));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({
      id: "thread-fs166",
      projectId: "bb-project-fs166",
      environmentId: "environment-fs166",
    }));
    host.harness.sdk.stub("environments.get", async () => ({
      id: "environment-fs166",
      projectId: "bb-project-fs166",
      path: worktreeRoot!,
    }));

    const runDefaultPull = () => host!.harness.behavior.runCli(
      [
        "finite-state",
        "pull",
        "--project",
        PROJECT_ID,
        "--version",
        VERSION_ID,
        "--json",
      ],
      {
        cwd: "/untrusted-cwd",
        threadId: "thread-fs166",
        projectId: "bb-project-fs166",
      },
    );

    const first = await runDefaultPull();
    expect(first).toMatchObject({ exitCode: 0, stderr: "" });
    const firstReport = JSON.parse(first.stdout) as {
      generationId: string;
      kinds: Record<string, { fetched: number; baseRows: number }>;
    };
    expect(firstReport.kinds).toMatchObject({
      vexDecision: { fetched: 308, baseRows: 308 },
      ...Object.fromEntries(TARA_KINDS.map((kind) => [kind, {
        fetched: expectedCounts[kind],
        baseRows: expectedCounts[kind],
      }])),
    });
    expect(requestedPageSizes).toEqual(
      TARA_KINDS.map(() => ASSURANCE_STUDIO_MAX_PAGE_SIZE),
    );

    const snapshots = new BaseSnapshotStore(context.db());
    const acceptedByName = new Map<string, Record<string, unknown>>();
    for (const kind of TARA_KINDS) {
      const accepted = snapshots.listAccepted(PROJECT_ID, VERSION_ID, kind);
      expect(accepted).toHaveLength(expectedCounts[kind]);
      for (const row of accepted) {
        expect(row.payload).toMatchObject({
          slug: expect.stringMatching(new RegExp(`^${kind}-[0-9a-f]{20}$`, "u")),
        });
        const name = row.payload["name"];
        if (typeof name === "string") acceptedByName.set(name, row.payload);
      }
    }
    const componentSlug = acceptedByName.get("Architecture node 1")?.["slug"];
    const nextComponentSlug = acceptedByName.get("Architecture node 2")?.["slug"];
    const zoneSlug = acceptedByName.get("Untrusted")?.["slug"];
    const assetSlug = acceptedByName.get("Protected asset 1")?.["slug"];
    expect(acceptedByName.get("Architecture node 1")).toMatchObject({
      component_type: "software",
      criticality: "low",
      zone: zoneSlug,
      interfaces: [{ name: "ethernet" }],
      technologies: ["linux"],
      is_entry_point: true,
      stores_data: true,
    });
    expect(acceptedByName.get("Untrusted")).toMatchObject({
      trust_level: "untrusted",
    });
    expect(acceptedByName.get("Protected asset 1")).toMatchObject({
      asset_type: "data",
      criticality: "critical",
      data_classification: "restricted",
    });
    expect(acceptedByName.get("Dataflow 1")).toMatchObject({
      from: componentSlug,
      to: nextComponentSlug,
      protocol: "MQTT",
      data_types: ["telemetry"],
      encrypted: false,
      authenticated: false,
      bidirectional: false,
    });
    const threat = acceptedByName.get("Threat 1");
    expect(threat).toMatchObject({
      category: "spoofing",
      threat_source: "stride_analysis",
      affected_assets: [assetSlug],
      mitigations: [expect.stringMatching(/^mitigation-[0-9a-f]{20}$/u)],
      assumptions: ["Fixture precondition 1"],
    });
    expect(threat).not.toHaveProperty("severity");
    expect(threat).not.toHaveProperty("affected_components");
    expect(threat).not.toHaveProperty("dataflows");

    const idMaps = new IdMapStore(context.db());
    const taraMappings = () => idMaps.dumpAccepted(PROJECT_ID, VERSION_ID)
      .filter((entry) => TARA_KINDS.some((kind) => kind === entry.entityKind))
      .map(({ entityKind, entityKey, remoteId }) => ({
        entityKind,
        entityKey,
        remoteId,
      }));
    const firstMappings = taraMappings();
    expect(firstMappings).toHaveLength(
      TARA_KINDS.reduce((total, kind) => total + expectedCounts[kind], 0),
    );

    corrupt = true;
    const failed = await runDefaultPull();
    expect(failed.exitCode).toBe(1);
    const failureMessage = `${failed.stdout}\n${failed.stderr}`;
    for (const [kind, field] of Object.entries(corruptionFields)) {
      expect(failureMessage).toContain(
        `${kind}: REMOTE_FIELD_MISSING: ${kind} payload lacks`,
      );
      expect(failureMessage).toContain(field);
    }
    const acceptedAfterFailure = context.db().prepare(
      `SELECT entity_kind, accepted_generation_id
         FROM sync_state
        WHERE project_id = ? AND project_version_id = ?
          AND entity_kind IN ('asset', 'component', 'dataflow', 'threat', 'zone')
        ORDER BY entity_kind`,
    ).all(PROJECT_ID, VERSION_ID) as Array<{
      entity_kind: string;
      accepted_generation_id: string | null;
    }>;
    expect(acceptedAfterFailure).toHaveLength(TARA_KINDS.length);
    expect(acceptedAfterFailure.every(
      (row) => row.accepted_generation_id === firstReport.generationId,
    )).toBe(true);
    expect(context.db().prepare(
      `SELECT status, error FROM pull_generation
        WHERE project_id = ? AND project_version_id = ?
          AND status = 'staging'
        LIMIT 1`,
    ).get(PROJECT_ID, VERSION_ID)).toMatchObject({
      status: "staging",
      error: expect.stringContaining("zone: REMOTE_FIELD_MISSING"),
    });

    corrupt = false;
    const recovered = await runDefaultPull();
    expect(recovered.exitCode).toBe(0);
    expect(taraMappings()).toEqual(firstMappings);
    expect(host.harness.registrations.rpcMethods).toContain("syncPull");
    expect(host.harness.realtimeSignals.some(
      (signal) => signal.channel === "fs-sync-pull",
    )).toBe(true);

    assuranceStudio.close();
    platform.close();
  });

  it("fails every adapter-derived required read group when the real fixture omits it", async () => {
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
      fetch: harness.assuranceStudio.fetch,
    });
    const scope = { projectId: PROJECT_ID, projectVersionId: VERSION_ID };

    for (const kind of TARA_KINDS) {
      const entity = (await listAll(client, kind))[0];
      if (!entity) throw new Error(`Fixture has no ${kind}`);
      for (const aliases of TARA_REMOTE_REQUIRED_FIELD_GROUPS[kind]) {
        const fields = { ...entity.fields };
        for (const alias of aliases) delete fields[alias];
        expect(
          () => projectRemoteEntity(
            kind,
            { ...entity, fields },
            scope,
            derivedResolver,
          ),
          `${kind} should reject missing ${aliases.join("/")}`,
        ).toThrow();
      }
    }

    const threat = (await listAll(client, "threat"))[0];
    if (!threat) throw new Error("Fixture has no threat");
    expect(() => projectRemoteEntity(
      "threat",
      {
        ...threat,
        fields: {
          ...threat.fields,
          stride_categories: ["spoofing", "tampering"],
        },
      },
      scope,
      derivedResolver,
    )).toThrow(/REMOTE_FIELD_UNSUPPORTED.*2 stride_categories/iu);

    client.close();
  });
});
