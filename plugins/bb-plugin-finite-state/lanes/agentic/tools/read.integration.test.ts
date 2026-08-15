import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";

import { createPluginContext } from "../../../lib/context.js";
import {
  AGENT_TOOL_REGISTRY,
  DIRECTIVE_IDS,
} from "../../../lib/agentic/registry.js";
import { SOFT_RESPONSE_BYTES } from "../../../lib/agentic/budget.js";
import {
  registerReadTools,
  type FindingSummary,
  type Page,
  type ReadServices,
} from "./read.js";

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

function pageOf<T>(
  items: T[],
  cursor: string | null = null,
  total = items.length,
): Page<T> {
  return { items, total, cursor, freshness: emptyFreshness };
}

type ToolJson = {
  ok: boolean;
  data?: {
    items?: Array<{ id: string; directive?: string }>;
    cursor?: string | null;
    planId?: string;
    directive?: string;
    stale?: boolean;
    basePulledAt?: string | null;
    recoveryHint?: string | null;
    freshness?: { stale?: boolean; source?: string };
  };
  meta?: { truncated?: boolean; nextCursor?: string };
};

function decoded(
  result: Awaited<
    ReturnType<
      ReturnType<
        typeof createFakePluginHost
      >["harness"]["behavior"]["callAgentTool"]
    >
  >,
): ToolJson {
  if (typeof result === "string") return JSON.parse(result) as ToolJson;
  const text = result.content.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("tool returned no text");
  return JSON.parse(text) as ToolJson;
}

function fixture(services: ReadServices) {
  const host = createFakePluginHost({
    pluginId: `fs-read-int-${crypto.randomUUID()}`,
  });
  hosts.push(host);
  const ctx = createPluginContext(host.bb);
  registerReadTools(host.bb, ctx, services);
  return { host, ctx };
}

describe("read tools integration", () => {
  it("query → returned id → paired directive lookup succeeds for one item per surface", async () => {
    const services: ReadServices = {
      sync: {
        status: async () => ({ ok: true }),
        plan: async () => ({
          planId: "01JABCDEFGHJKMNPQRSTVWXYZZ",
          directive: "fs-plan",
          items: [],
          total: 0,
          cursor: null,
          stale: false,
          basePulledAt: emptyFreshness.cachePulledAt,
          recoveryHint: null,
          freshness: emptyFreshness,
        }),
      },
      findings: {
        query: () =>
          pageOf<FindingSummary>([
            {
              id: "finding-stable-1",
              cve: "CVE-1",
              component: { name: "busybox", version: "1", purl: null },
              severity: "high",
              epss: null,
              kev: false,
              reachability: null,
              serverDecision: null,
              localDecision: null,
              directive: "fs-finding",
            },
          ]),
      },
      tara: {
        query: () =>
          pageOf([{ id: "THREAT-1", directive: "fs-threat", kind: "threat" }]),
        earsBundle: async () => ({ bundleId: "b1", forgeCalls: 0 }),
        earsValidate: async () => ({ wrote: false, results: [] }),
      },
      bom: {
        querySbom: () => pageOf([{ id: "comp-1", directive: "fs-component" }]),
        reviewHbom: () => pageOf([{ id: "HBOM-0001:mpn" }]),
      },
      bench: {
        status: () => pageOf([{ id: "verdict-1", directive: "fs-verdict" }]),
      },
      documents: {
        search: () => pageOf([{ id: "doc-1", directive: "fs-doc" }]),
      },
    };
    const { host } = fixture(services);

    const pairs: Array<{
      tool: string;
      args: Record<string, unknown>;
      directive: (typeof DIRECTIVE_IDS)[number] | null;
    }> = [
      {
        tool: "fs_sync_plan",
        args: { projectId: "p1" },
        directive: AGENT_TOOL_REGISTRY.fs_sync_plan.directive ?? null,
      },
      {
        tool: "fs_findings_query",
        args: { projectId: "p1", version: "v1" },
        directive: AGENT_TOOL_REGISTRY.fs_findings_query.directive ?? null,
      },
      {
        tool: "fs_tara_query",
        args: { projectId: "p1", kind: "threat" },
        directive: AGENT_TOOL_REGISTRY.fs_tara_query.directive ?? null,
      },
      {
        tool: "fs_sbom_query",
        args: { projectId: "p1", version: "v1" },
        directive: AGENT_TOOL_REGISTRY.fs_sbom_query.directive ?? null,
      },
      {
        tool: "fs_bench_status",
        args: { projectId: "p1", pv_id: "v1", want: "verdict" },
        directive: AGENT_TOOL_REGISTRY.fs_bench_status.directive ?? null,
      },
      {
        tool: "fs_doc_search",
        args: { project_id: "p1", query: "BCM" },
        directive: AGENT_TOOL_REGISTRY.fs_doc_search.directive ?? null,
      },
    ];

    for (const pair of pairs) {
      const result = decoded(
        await host.harness.behavior.callAgentTool(pair.tool, pair.args),
      );
      expect(result.ok).toBe(true);
      if (pair.tool === "fs_sync_plan") {
        expect(result.data?.planId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
        expect(result.data?.directive).toBe(pair.directive);
        expect(DIRECTIVE_IDS).toContain(pair.directive);
        continue;
      }
      const id = result.data?.items?.[0]?.id;
      expect(id).toEqual(expect.any(String));
      expect(result.data?.items?.[0]?.directive).toBe(pair.directive);
      expect(DIRECTIVE_IDS).toContain(pair.directive);
    }
  });

  it("sync plan refresh timeout returns stale base and recovery hint", async () => {
    const plan = vi.fn(async () => ({
      planId: "01PLANSTALE000000000000000",
      directive: "fs-plan",
      items: [],
      total: 0,
      cursor: null,
      stale: true,
      basePulledAt: "2026-08-14T12:00:00.000Z",
      recoveryHint:
        "Upstream refresh failed or timed out; this plan uses the last-pulled base snapshot. Push-time state may differ — re-run fs_sync_plan when online before asking a human to push.",
      freshness: {
        cachePulledAt: "2026-08-14T12:00:00.000Z",
        stale: true,
        source: "base-snapshot" as const,
      },
    }));
    const { host } = fixture({
      sync: { status: async () => ({}), plan },
      findings: { query: () => pageOf([]) },
      tara: {
        query: () => pageOf([]),
        earsBundle: async () => ({}),
        earsValidate: async () => ({}),
      },
      bom: {
        querySbom: () => pageOf([]),
        reviewHbom: () => pageOf([]),
      },
      bench: { status: () => pageOf([]) },
      documents: { search: () => pageOf([]) },
    });

    const result = decoded(
      await host.harness.behavior.callAgentTool("fs_sync_plan", {
        projectId: "p1",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        stale: true,
        basePulledAt: "2026-08-14T12:00:00.000Z",
        recoveryHint: expect.stringMatching(/Push-time state may differ/u),
        freshness: { stale: true, source: "base-snapshot" },
      },
    });
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("cursor resumes without duplicate or skipped ids", async () => {
    const ids = ["a", "b", "c", "d"];
    const query = vi.fn((input: { cursor?: string; limit?: number }) => {
      const start = input.cursor ? ids.indexOf(input.cursor) + 1 : 0;
      const limit = input.limit ?? 2;
      const slice = ids.slice(start, start + limit);
      const last = slice.at(-1);
      const more = start + limit < ids.length;
      return pageOf(
        slice.map((id) => ({
          id,
          cve: null,
          component: { name: id, version: null, purl: null },
          severity: null,
          epss: null,
          kev: false,
          reachability: null,
          serverDecision: null,
          localDecision: null,
          directive: "fs-finding" as const,
        })),
        more && last ? last : null,
        ids.length,
      );
    });
    const { host } = fixture({
      sync: {
        status: async () => ({}),
        plan: async () => ({
          planId: "01JABCDEFGHJKMNPQRSTVWXYZZ",
          directive: "fs-plan",
          items: [],
          total: 0,
          cursor: null,
          stale: false,
          basePulledAt: null,
          recoveryHint: null,
          freshness: emptyFreshness,
        }),
      },
      findings: { query },
      tara: {
        query: () => pageOf([]),
        earsBundle: async () => ({}),
        earsValidate: async () => ({}),
      },
      bom: {
        querySbom: () => pageOf([]),
        reviewHbom: () => pageOf([]),
      },
      bench: { status: () => pageOf([]) },
      documents: { search: () => pageOf([]) },
    });

    const first = decoded(
      await host.harness.behavior.callAgentTool("fs_findings_query", {
        projectId: "p1",
        version: "v1",
        limit: 2,
      }),
    );
    const second = decoded(
      await host.harness.behavior.callAgentTool("fs_findings_query", {
        projectId: "p1",
        version: "v1",
        limit: 2,
        cursor: first.data?.cursor ?? undefined,
      }),
    );
    const seen = [
      ...(first.data?.items ?? []).map((item) => item.id),
      ...(second.data?.items ?? []).map((item) => item.id),
    ];
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(new Set(seen).size).toBe(4);
  });

  it("oversized seed page is shortened at row boundaries", async () => {
    const query = vi.fn((input: { limit?: number }) => {
      const limit = input.limit ?? 50;
      return pageOf(
        Array.from({ length: limit }, (_, index) => ({
          id: `row-${index}`,
          cve: null,
          component: { name: "x", version: null, purl: null },
          severity: null,
          epss: null,
          kev: false,
          reachability: null,
          serverDecision: null,
          localDecision: null,
          directive: "fs-finding" as const,
          summary: "y".repeat(400),
        })),
        "continue",
        500,
      );
    });
    const { host } = fixture({
      sync: {
        status: async () => ({}),
        plan: async () => ({
          planId: "01JABCDEFGHJKMNPQRSTVWXYZZ",
          directive: "fs-plan",
          items: [],
          total: 0,
          cursor: null,
          stale: false,
          basePulledAt: null,
          recoveryHint: null,
          freshness: emptyFreshness,
        }),
      },
      findings: { query },
      tara: {
        query: () => pageOf([]),
        earsBundle: async () => ({}),
        earsValidate: async () => ({}),
      },
      bom: {
        querySbom: () => pageOf([]),
        reviewHbom: () => pageOf([]),
      },
      bench: { status: () => pageOf([]) },
      documents: { search: () => pageOf([]) },
    });

    const result = decoded(
      await host.harness.behavior.callAgentTool("fs_findings_query", {
        projectId: "p1",
        version: "v1",
        limit: 50,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.meta?.truncated).toBe(true);
    expect((result.data?.items ?? []).length).toBeGreaterThan(0);
    expect((result.data?.items ?? []).length).toBeLessThan(50);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      SOFT_RESPONSE_BYTES + 512,
    );
    expect(query.mock.calls.some((call) => (call[0]?.limit ?? 50) < 50)).toBe(
      true,
    );
  });
});
