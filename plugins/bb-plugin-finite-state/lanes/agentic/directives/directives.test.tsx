// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  installTestPluginRuntime,
  loadPluginApp,
  renderSlot,
} from "@bb/plugin-sdk/testing/app";
import { findingStableKey } from "../../../lib/sync/registry.js";
import { AGENT_SURFACE, DIRECTIVE_IDS } from "../../../lib/agentic/registry.js";
import { PR1_DIRECTIVE_IDS, PR2_DIRECTIVE_IDS } from "./attributes.js";
import {
  DirectiveBoundary,
  DirectiveEmptyState,
  DirectiveErrorState,
  DirectiveLoadingState,
  DirectiveUnconfiguredState,
} from "./DirectiveBoundary.js";

beforeAll(() => installTestPluginRuntime());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const stableKey = findingStableKey(
  {
    cve: "CVE-2026-0039",
    purl: "pkg:generic/gateway@1.0.0",
    name: "gateway",
    version: "1.0.0",
  },
  "purl",
);

const freshCache = {
  state: "fresh" as const,
  asOf: "2026-08-15T00:00:00.000Z",
  message: null,
  acceptedGenerationId: "generation-1",
  baseRevision: 1,
};

const emptyCache = {
  state: "empty" as const,
  asOf: null,
  message: "Cache is cold — pull to load.",
  acceptedGenerationId: null,
  baseRevision: null,
};

function messageProps(
  attributes: Record<string, string>,
  projectId: string | null = "proj_1",
) {
  return {
    attributes,
    source: `::directive${JSON.stringify(attributes)}`,
    message: {
      id: "msg_1",
      threadId: "thr_1",
      turnId: "turn_1",
      projectId,
    },
    openWorkspaceFile: null as null,
  };
}

function findingDetailWarm() {
  return {
    state: "resolved" as const,
    tier: 1 as const,
    rows: [
      {
        projectId: "platform-1",
        projectVersionId: "version-1",
        kind: "finding",
        key: "finding-1",
        label: "Gateway vulnerability",
        fields: {
          stableKey,
          cve: "CVE-2026-0039",
          title: "Gateway vulnerability",
          componentName: "gateway",
          componentPurl: "pkg:generic/gateway@1.0.0",
          severity: "high",
          reachabilityVerdict: "reachable",
          localState: "none",
        },
        cache: freshCache,
      },
    ],
    cache: freshCache,
  };
}

function requirementWarm() {
  return {
    projectId: "proj_1",
    projectVersionId: null,
    kind: "requirement",
    key: "REQ-118",
    label: "REQ-118",
    fields: {
      requirement: {
        schema: "fs-requirement/v1",
        id: "REQ-118",
        req_type: "security",
        priority: "P1",
        status: "draft",
        ears: {
          pattern: "event_driven",
          text: "WHEN a session is established THEN the service SHALL bind the token.",
          parts: {
            trigger: "a session is established",
            system: "service",
            response: "bind the token",
          },
        },
        standards: [],
        mitigations: [],
        controls: [],
        verification: [],
        source_description: "Derived from THREAT-22",
      },
      evidenceState: "not_run",
      tiers: [
        { tier: "static", state: "not_run", count: 0 },
        { tier: "emulation", state: "not_run", count: 0 },
        { tier: "hil", state: "not_run", count: 0 },
        { tier: "manual", state: "not_run", count: 0 },
      ],
      local: true,
      stale: false,
      sourceSha256: "a".repeat(64),
    },
    links: [],
    cache: freshCache,
  };
}

function componentWarm(id: string) {
  return {
    projectId: "platform-1",
    projectVersionId: "version-1",
    kind: "sbomComponent",
    key: id,
    label: "Gateway",
    fields: {
      purl: id,
      version: "1",
      license: "MIT",
      files: ["usr/bin/gateway"],
      findings: [],
    },
    links: [],
    cache: freshCache,
  };
}

function hbomWarm() {
  return {
    items: [
      {
        projectId: "proj_1",
        projectVersionId: null,
        kind: "hbomSummary",
        key: "summary",
        label: "HBOM trust",
        fields: {
          partCount: 12,
          verifiedRatio: 0.5,
          queueDepth: 3,
          cellCount: 40,
        },
        cache: freshCache,
      },
    ],
    total: 1,
    continuation: null,
    cache: freshCache,
  };
}

function verdictWarm() {
  return {
    pvId: "pv-1",
    firmwareDigest: "a".repeat(64),
    currentMountedDigest: "a".repeat(64),
    verdict: "SAFE_TO_OTA" as const,
    stale: false,
    required: 1,
    proven: 1,
    failed: 0,
    gaps: 0,
    evidence: [],
    issues: [],
    computedAt: "2026-08-15T00:00:00.000Z",
  };
}

describe("WP-61 PR1 directives", () => {
  it("registers exactly the six PR1 ids and keeps registry parity", async () => {
    const app = await loadPluginApp(() => import("../../../app.js"));
    const registered = app.messageDirectives.map((directive) => directive.id);
    expect(registered.sort()).toEqual([...PR1_DIRECTIVE_IDS].sort());
    expect(registered).toHaveLength(6);
    for (const id of registered) {
      expect(AGENT_SURFACE.directives).toContain(id);
    }
    for (const id of PR2_DIRECTIVE_IDS) {
      expect(registered).not.toContain(id);
      expect(DIRECTIVE_IDS).toContain(id);
    }
  });

  it("renders shared UI states without crashing the message tree", () => {
    const loading = renderSlot(
      { component: () => <DirectiveLoadingState label="Loading directive" /> },
      {},
    );
    expect(loading.getByLabelText("Loading directive")).toBeTruthy();

    const empty = renderSlot(
      {
        component: () => (
          <DirectiveEmptyState
            detail="Pull to load this entity from the accepted cache."
            title="Not found / pull to load"
          />
        ),
      },
      {},
    );
    expect(empty.getByText("Not found / pull to load")).toBeTruthy();

    const error = renderSlot(
      {
        component: () => (
          <DirectiveErrorState
            detail="RPC failed"
            onRetry={() => undefined}
            title="Unavailable"
          />
        ),
      },
      {},
    );
    expect(error.getByRole("button", { name: "Retry" })).toBeTruthy();

    const unconfigured = renderSlot(
      {
        component: () => (
          <DirectiveUnconfiguredState
            detail="Configure the remote connection."
            title="Setup required"
          />
        ),
      },
      {},
    );
    expect(unconfigured.getByText("Setup required")).toBeTruthy();
  });

  it("RPC failure renders retry card and ErrorBoundary preserves message", async () => {
    const app = await loadPluginApp(() => import("../../../app.js"));
    const finding = app.messageDirectives.find(
      (directive) => directive.id === "fs-finding",
    );
    expect(finding).toBeTruthy();
    const slot = renderSlot(finding!, messageProps({ id: stableKey }), {
      context: { projectId: "proj_1" },
      rpc: {
        cachedProjectVersions: () => ({
          versions: [
            {
              platformProjectId: "platform-1",
              projectVersionId: "version-1",
              asOf: "2026-08-15T00:00:00.000Z",
              state: "fresh",
            },
          ],
          selectedPlatformProjectId: "platform-1",
          selectedProjectVersionId: "version-1",
        }),
        findingDetailGet: () =>
          Promise.reject(new Error("FINDINGS_DETAIL_UNAVAILABLE")),
      },
    });
    expect(await slot.findByText("Finding unavailable")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Retry" })).toBeTruthy();

    function Boom(): React.JSX.Element {
      throw new Error("directive boom");
    }
    const crashed = renderSlot(
      {
        component: () => (
          <div>
            <span>message-safe</span>
            <DirectiveBoundary source='::fs-finding{id="x"}'>
              <Boom />
            </DirectiveBoundary>
          </div>
        ),
      },
      {},
    );
    expect(crashed.getByText("message-safe")).toBeTruthy();
    expect(crashed.getByText("Directive failed to render")).toBeTruthy();
    expect(crashed.getByText('::fs-finding{id="x"}')).toBeTruthy();
  });

  it("unconfigured host renders setup guidance", async () => {
    const app = await loadPluginApp(() => import("../../../app.js"));
    const req = app.messageDirectives.find(
      (directive) => directive.id === "fs-req",
    );
    expect(req).toBeTruthy();
    const slot = renderSlot(req!, messageProps({ id: "REQ-118" }, null), {
      context: { projectId: null },
    });
    expect(await slot.findByText("Choose a project")).toBeTruthy();
  });

  it("no directive performs a Forge request", async () => {
    const app = await loadPluginApp(() => import("../../../app.js"));
    const forge = vi.fn(() => {
      throw new Error("Forge must not be called from directives");
    });
    const rpc = {
      cachedProjectVersions: () => ({
        versions: [
          {
            platformProjectId: "platform-1",
            projectVersionId: "version-1",
            asOf: "2026-08-15T00:00:00.000Z",
            state: "fresh",
          },
        ],
        selectedPlatformProjectId: "platform-1",
        selectedProjectVersionId: "version-1",
      }),
      findingDetailGet: () => findingDetailWarm(),
      requirementsGet: () => requirementWarm(),
      bomCachedProjectVersions: () => ({
        versions: [
          {
            platformProjectId: "platform-1",
            projectVersionId: "version-1",
            asOf: "2026-08-15T00:00:00.000Z",
            state: "fresh",
          },
        ],
        selectedPlatformProjectId: "platform-1",
        selectedProjectVersionId: "version-1",
      }),
      bomComponentGet: (input: unknown) => {
        const componentId =
          typeof input === "object" &&
          input !== null &&
          "componentId" in input &&
          typeof input.componentId === "string"
            ? input.componentId
            : "pkg:generic/gateway@1";
        return componentWarm(componentId);
      },
      hbomReviewList: () => hbomWarm(),
      benchRunGet: () => ({
        run: {
          id: "run-1",
          status: "succeeded",
          tier: "tier0",
          startedAt: "2026-08-15T00:00:00.000Z",
          finishedAt: "2026-08-15T00:01:00.000Z",
        },
      }),
      benchOtaVerdictGet: () => verdictWarm(),
      forgeJobCreate: forge,
      forgeJobStatus: forge,
      forgeCompute: forge,
    };

    const cases: Array<{
      id: (typeof PR1_DIRECTIVE_IDS)[number];
      attributes: Record<string, string>;
    }> = [
      { id: "fs-finding", attributes: { id: stableKey } },
      { id: "fs-req", attributes: { id: "REQ-118" } },
      {
        id: "fs-component",
        attributes: { purl: "pkg:generic/gateway@1" },
      },
      { id: "fs-hbom-summary", attributes: {} },
      { id: "fs-bench", attributes: { id: "run-1" } },
      { id: "fs-verdict", attributes: { id: "pv-1" } },
    ];

    for (const item of cases) {
      const registration = app.messageDirectives.find(
        (directive) => directive.id === item.id,
      );
      expect(registration).toBeTruthy();
      renderSlot(registration!, messageProps(item.attributes), {
        context: { projectId: "proj_1" },
        rpc,
      });
    }
    expect(forge).not.toHaveBeenCalled();
    for (const call of Object.values(
      // Collect across slots is awkward; assert forge stubs were never hit.
      {},
    )) {
      void call;
    }
  });

  it("cold-cache and warm-cache renders work per PR1 directive", async () => {
    const app = await loadPluginApp(() => import("../../../app.js"));

    const finding = app.messageDirectives.find(
      (directive) => directive.id === "fs-finding",
    )!;
    const coldFinding = renderSlot(finding, messageProps({ id: stableKey }), {
      context: { projectId: "proj_1" },
      rpc: {
        cachedProjectVersions: () => ({
          versions: [],
          selectedPlatformProjectId: null,
          selectedProjectVersionId: null,
        }),
      },
    });
    expect(
      await coldFinding.findByText(/Choose a findings scope|not found|pull/iu),
    ).toBeTruthy();
    cleanup();

    const warmFinding = renderSlot(finding, messageProps({ id: stableKey }), {
      context: { projectId: "proj_1" },
      rpc: {
        cachedProjectVersions: () => ({
          versions: [
            {
              platformProjectId: "platform-1",
              projectVersionId: "version-1",
              asOf: "2026-08-15T00:00:00.000Z",
              state: "fresh",
            },
          ],
          selectedPlatformProjectId: "platform-1",
          selectedProjectVersionId: "version-1",
        }),
        findingDetailGet: () => findingDetailWarm(),
      },
    });
    expect(await warmFinding.findByText("CVE-2026-0039")).toBeTruthy();
    fireEvent.click(
      warmFinding.getByRole("button", { name: "Open in Findings" }),
    );
    expect(warmFinding.inspection.navigateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "toPluginPanel",
          path: "findings",
          options: expect.objectContaining({
            subPath: expect.stringContaining(`f/${stableKey}`),
          }),
        }),
      ]),
    );
    cleanup();

    const req = app.messageDirectives.find(
      (directive) => directive.id === "fs-req",
    )!;
    const warmReq = renderSlot(req, messageProps({ id: "REQ-118" }), {
      context: { projectId: "proj_1" },
      rpc: { requirementsGet: () => requirementWarm() },
    });
    expect(await warmReq.findByText("REQ-118")).toBeTruthy();
    expect(warmReq.queryByText("Edit local YAML")).toBeNull();
    cleanup();

    const component = app.messageDirectives.find(
      (directive) => directive.id === "fs-component",
    )!;
    const coldComponent = renderSlot(
      component,
      messageProps({ purl: "pkg:generic/gateway@1" }),
      {
        context: { projectId: "proj_1" },
        rpc: {
          bomCachedProjectVersions: () => ({
            versions: [],
            selectedPlatformProjectId: null,
            selectedProjectVersionId: null,
          }),
        },
      },
    );
    expect(
      await coldComponent.findByText("BOM scope unavailable"),
    ).toBeTruthy();
    cleanup();

    const warmComponent = renderSlot(
      component,
      messageProps({ purl: "pkg:generic/gateway@1" }),
      {
        context: { projectId: "proj_1" },
        rpc: {
          bomCachedProjectVersions: () => ({
            versions: [
              {
                platformProjectId: "platform-1",
                projectVersionId: "version-1",
                asOf: "2026-08-15T00:00:00.000Z",
                state: "fresh",
              },
            ],
            selectedPlatformProjectId: "platform-1",
            selectedProjectVersionId: "version-1",
          }),
          bomComponentGet: () => componentWarm("pkg:generic/gateway@1"),
        },
      },
    );
    expect(await warmComponent.findByText("Gateway")).toBeTruthy();
    cleanup();

    const hbom = app.messageDirectives.find(
      (directive) => directive.id === "fs-hbom-summary",
    )!;
    const coldHbom = renderSlot(hbom, messageProps({}), {
      context: { projectId: "proj_1" },
      rpc: {
        hbomReviewList: () => ({
          items: [],
          total: 0,
          continuation: null,
          cache: emptyCache,
        }),
      },
    });
    await waitFor(() => {
      expect(coldHbom.container.textContent).toMatch(/No HBOM|pull|Seed/iu);
    });
    cleanup();

    const warmHbom = renderSlot(hbom, messageProps({}), {
      context: { projectId: "proj_1" },
      rpc: { hbomReviewList: () => hbomWarm() },
    });
    await waitFor(() => {
      expect(warmHbom.container.textContent).toMatch(/12|50%|queue/iu);
    });
    cleanup();

    const verdict = app.messageDirectives.find(
      (directive) => directive.id === "fs-verdict",
    )!;
    const warmVerdict = renderSlot(verdict, messageProps({ id: "pv-1" }), {
      context: { projectId: "proj_1" },
      rpc: { benchOtaVerdictGet: () => verdictWarm() },
    });
    expect(await warmVerdict.findByLabelText(/OTA verdict/iu)).toBeTruthy();
    cleanup();

    const bench = app.messageDirectives.find(
      (directive) => directive.id === "fs-bench",
    )!;
    const warmBench = renderSlot(bench, messageProps({ id: "run-1" }), {
      context: { projectId: "proj_1" },
      rpc: {
        benchRunGet: () =>
          Promise.reject(new Error("BENCH_RUN_NOT_FOUND: cold cache")),
      },
    });
    expect(await warmBench.findByText("Unknown bench run")).toBeTruthy();
  });

  it("rejects unknown attributes before any owner RPC", async () => {
    const app = await loadPluginApp(() => import("../../../app.js"));
    const finding = app.messageDirectives.find(
      (directive) => directive.id === "fs-finding",
    )!;
    const calls: unknown[] = [];
    const slot = renderSlot(
      finding,
      messageProps({ id: stableKey, hostile: "yes" }),
      {
        context: { projectId: "proj_1" },
        rpc: {
          findingDetailGet: (input: unknown) => {
            calls.push(input);
            return findingDetailWarm();
          },
        },
      },
    );
    expect(await slot.findByText("Invalid directive attributes")).toBeTruthy();
    expect(calls).toEqual([]);
  });
});
