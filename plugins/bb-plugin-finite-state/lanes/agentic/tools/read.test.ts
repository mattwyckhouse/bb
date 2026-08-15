import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";

import { createPluginContext } from "../../../lib/context.js";
import { AGENT_TOOL_REGISTRY } from "../../../lib/agentic/registry.js";
import { SOFT_RESPONSE_BYTES } from "../../../lib/agentic/budget.js";
import {
  fitPagedResult,
  registerReadTools,
  type FindingSummary,
  type Page,
  type ReadServices,
} from "./read.js";
import {
  benchStatusSchema,
  docSearchSchema,
  earsConvertSchema,
  findingsQuerySchema,
  hbomReviewSchema,
  sbomQuerySchema,
  syncPlanSchema,
  syncStatusSchema,
  taraQuerySchema,
} from "./read-schemas.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

const emptyFreshness = {
  cachePulledAt: "2026-08-15T00:00:00.000Z",
  stale: false,
  source: "cache" as const,
};

function pageOf<T>(items: T[], cursor: string | null = null): Page<T> {
  return {
    items,
    total: items.length,
    cursor,
    freshness: emptyFreshness,
  };
}

function mockServices(overrides: Partial<ReadServices> = {}): ReadServices {
  const findingsQuery = vi.fn(
    (): Page<FindingSummary> =>
      pageOf([
        {
          id: "stable-busybox-cve",
          cve: "CVE-2024-1",
          component: {
            name: "busybox",
            version: "1.36.1",
            purl: "pkg:generic/busybox@1.36.1",
          },
          severity: "high",
          epss: 0.9,
          kev: true,
          reachability: "reachable",
          serverDecision: null,
          localDecision: null,
          directive: "fs-finding",
        },
      ]),
  );
  const base: ReadServices = {
    sync: {
      status: vi.fn(async () => ({
        counts: { local: 1, upstream: 0, conflicts: 0, orphans: 0 },
        freshness: emptyFreshness,
      })),
      plan: vi.fn(async () => ({
        planId: "01PLANTEST0000000000000000",
        directive: "fs-plan",
        stale: false,
        basePulledAt: emptyFreshness.cachePulledAt,
        recoveryHint: null,
        items: [
          {
            id: "finding:k1",
            kind: "finding",
            key: "k1",
            operation: "update",
            error: null,
          },
        ],
        total: 1,
        cursor: null,
        freshness: emptyFreshness,
      })),
    },
    findings: { query: findingsQuery },
    tara: {
      query: vi.fn(
        (): Page<unknown> => ({
          items: [
            {
              id: "threat->REQ-1",
              kind: "trace",
              directive: "fs-threat",
              unresolved: {
                from: "threat",
                to: "REQ-1",
                reason: "Threat cache lookup failed",
              },
            },
          ],
          total: 1,
          cursor: null,
          freshness: {
            ...emptyFreshness,
            unresolved: [
              {
                from: "threat",
                to: "REQ-1",
                reason: "Threat cache lookup failed",
              },
            ],
          },
        }),
      ),
      earsBundle: vi.fn(async () => ({
        bundleId: "ears-1",
        forgeCalls: 0,
        items: [{ id: "REQ-1", checkCount: 0 }],
        cursor: null,
        freshness: emptyFreshness,
      })),
      earsValidate: vi.fn(async () => ({
        wrote: false,
        results: [
          {
            requirementId: "REQ-1",
            schemaOk: true,
            roundTripOk: true,
            unresolved: [],
            humanReview: "pending",
          },
        ],
      })),
    },
    bom: {
      querySbom: vi.fn(
        (): Page<unknown> =>
          pageOf([
            {
              id: "comp-1",
              name: "busybox",
              directive: "fs-component",
              vuln: { critical: 0, high: 1, medium: 0, low: 0, kev: 1 },
            },
          ]),
      ),
      reviewHbom: vi.fn(
        (): Page<unknown> =>
          pageOf([
            {
              id: "HBOM-0001:mpn",
              fields: { state: "proposal", reason: "below_threshold" },
            },
          ]),
      ),
    },
    bench: {
      status: vi.fn(
        (): Page<unknown> =>
          pageOf([
            {
              id: "run-1",
              directive: "fs-bench",
              status: "passed",
            },
          ]),
      ),
    },
    documents: {
      search: vi.fn(
        (): Page<unknown> =>
          pageOf([
            {
              id: "docsha",
              directive: "fs-doc",
              field: "mpn",
              sourceRef: { documentSha256: "docsha", page: 1 },
            },
          ]),
      ),
    },
    ...overrides,
  };
  return base;
}

function fixture(services: ReadServices = mockServices()) {
  const host = createFakePluginHost({
    pluginId: `fs-read-${crypto.randomUUID()}`,
  });
  hosts.push(host);
  const ctx = createPluginContext(host.bb);
  registerReadTools(host.bb, ctx, services);
  return { host, ctx, services };
}

function decoded(
  result: Awaited<
    ReturnType<
      ReturnType<typeof fixture>["host"]["harness"]["behavior"]["callAgentTool"]
    >
  >,
) {
  if (typeof result === "string") return JSON.parse(result) as unknown;
  const text = result.content.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("tool returned no text");
  return JSON.parse(text) as unknown;
}

describe("read tool schemas", () => {
  const cases = [
    [
      "fs_sync_status",
      syncStatusSchema,
      { projectId: "p1" },
      { projectId: "p1", unexpected: true },
    ],
    [
      "fs_sync_plan",
      syncPlanSchema,
      { projectId: "p1" },
      { projectId: "p1", unexpected: true },
    ],
    [
      "fs_findings_query",
      findingsQuerySchema,
      { projectId: "p1", version: "v1" },
      { projectId: "p1", version: "v1", unexpected: true },
    ],
    [
      "fs_tara_query",
      taraQuerySchema,
      { projectId: "p1", kind: "threat" },
      { projectId: "p1", kind: "threat", unexpected: true },
    ],
    [
      "fs_ears_convert",
      earsConvertSchema,
      { action: "bundle", projectId: "p1" },
      { action: "bundle", projectId: "p1", unexpected: true },
    ],
    [
      "fs_sbom_query",
      sbomQuerySchema,
      { projectId: "p1", version: "v1" },
      { projectId: "p1", version: "v1", unexpected: true },
    ],
    [
      "fs_hbom_review",
      hbomReviewSchema,
      { projectId: "p1" },
      { projectId: "p1", unexpected: true },
    ],
    [
      "fs_bench_status",
      benchStatusSchema,
      { projectId: "p1", pv_id: "v1" },
      { projectId: "p1", pv_id: "v1", unexpected: true },
    ],
    [
      "fs_doc_search",
      docSearchSchema,
      { project_id: "p1", query: "BCM" },
      { project_id: "p1", query: "BCM", unexpected: true },
    ],
  ] as const;

  for (const [name, schema, valid, invalid] of cases) {
    it(`${name} accepts the declared shape and rejects unknown keys`, () => {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse(invalid).success).toBe(false);
      expect(
        AGENT_TOOL_REGISTRY[name as keyof typeof AGENT_TOOL_REGISTRY].class,
      ).toBe("read");
    });
  }
});

describe("read tool behavior", () => {
  it("findings query uses stable identity and omits raw payload", async () => {
    const { host, services } = fixture();
    const result = decoded(
      await host.harness.behavior.callAgentTool("fs_findings_query", {
        projectId: "p1",
        version: "v1",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        items: [{ id: "stable-busybox-cve", directive: "fs-finding" }],
      },
    });
    const payload = JSON.stringify(result);
    expect(payload).not.toMatch(/findingId|finding_id|"raw"/u);
    expect(services.findings.query).toHaveBeenCalledTimes(1);
  });

  it("tara trace reports unresolved link rather than omitting it", async () => {
    const { host } = fixture();
    const result = decoded(
      await host.harness.behavior.callAgentTool("fs_tara_query", {
        projectId: "p1",
        kind: "trace",
        filter: { requirementId: "REQ-1" },
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            unresolved: {
              from: "threat",
              to: "REQ-1",
              reason: "Threat cache lookup failed",
            },
          },
        ],
        freshness: {
          unresolved: [
            expect.objectContaining({ from: "threat", to: "REQ-1" }),
          ],
        },
      },
    });
  });

  it("ears bundle performs zero Forge calls", async () => {
    const earsBundle = vi.fn(async () => ({
      bundleId: "ears-1",
      forgeCalls: 0,
      items: [],
      cursor: null,
      freshness: emptyFreshness,
    }));
    const { host } = fixture(
      mockServices({
        tara: {
          query: vi.fn(),
          earsBundle,
          earsValidate: vi.fn(),
        },
      }),
    );
    const result = decoded(
      await host.harness.behavior.callAgentTool("fs_ears_convert", {
        action: "bundle",
        projectId: "p1",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: { forgeCalls: 0 },
    });
    expect(earsBundle).toHaveBeenCalledTimes(1);
  });

  it("hbom review has no mutation callback", async () => {
    const { host, services } = fixture();
    const result = decoded(
      await host.harness.behavior.callAgentTool("fs_hbom_review", {
        projectId: "p1",
        state: "all",
      }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(services.bom.reviewHbom).toHaveBeenCalledTimes(1);
    expect(Object.keys(services.bom)).toEqual(["querySbom", "reviewHbom"]);
    expect(JSON.stringify(result)).not.toMatch(/accept|reject|resolve/iu);
  });

  it("shortens oversized pages at row boundaries", async () => {
    const oversized = Array.from({ length: 50 }, (_, index) => ({
      id: `row-${index}`,
      summary: "x".repeat(300),
    }));
    const fitted = await fitPagedResult(
      (limit) => pageOf(oversized.slice(0, limit), "next"),
      50,
      SOFT_RESPONSE_BYTES,
    );
    expect(fitted.items.length).toBeGreaterThan(0);
    expect(fitted.items.length).toBeLessThan(50);
    expect(fitted.truncated).toBe(true);
    expect(fitted.items.every((item) => typeof item.id === "string")).toBe(
      true,
    );
  });
});
