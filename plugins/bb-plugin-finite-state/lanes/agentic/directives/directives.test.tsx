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
import { resolveTestTaraScope } from "../../product-security/canvas/scope/test-fixture.js";
import {
  MATRIX_DIRECTIVE_MAX_ROWS,
  PR1_DIRECTIVE_IDS,
  PR2_DIRECTIVE_IDS,
  REGISTERED_DIRECTIVE_IDS,
} from "./attributes.js";
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

const PLAN_ID = "01K2G8Z4Q9A1B2C3D4E5F6G7H8";
const DOC_ID = "a".repeat(64);
const TRIAGE_RUN_ID = "tr-20260811-1402";

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

function planWarm() {
  return {
    projectId: "proj_1",
    projectVersionId: "version-1",
    planId: PLAN_ID,
    planSha256: "a".repeat(64),
    baseGenerationIds: {},
    baseRevisions: {},
    baseStateSha256: "b".repeat(64),
    createdAt: "2026-08-15T00:00:00.000Z",
    staleness: { asOf: "2026-08-15T00:00:00.000Z", degraded: false },
    items: [],
    summary: {
      creates: 2,
      updates: 3,
      deletes: 1,
      noops: 0,
      conflicts: 1,
      orphans: 0,
    },
    blastRadius: {
      requiresHumanReview: true,
      changed: 6,
      deletes: 1,
      remoteCalls: 2,
      surfaces: ["threat"],
    },
    validationErrors: [],
    total: 6,
    next: null,
    cache: freshCache,
  };
}

function triageWarm() {
  return {
    runId: TRIAGE_RUN_ID,
    source: "policy" as const,
    status: "completed" as const,
    dryRun: false,
    written: 39,
    held: 2,
    conflicts: 0,
    skippedExisting: 1,
    errors: 0,
    holdbacks: [],
    createdAt: "2026-08-15T00:00:00.000Z",
    finishedAt: "2026-08-15T00:01:00.000Z",
  };
}

function threatWarm() {
  return {
    projectId: "proj_1",
    projectVersionId: null,
    kind: "threat",
    key: "THREAT-22",
    label: "Unsigned boot path",
    fields: {
      slug: "THREAT-22",
      name: "Unsigned boot path",
      category: "spoofing",
      severity: "high",
      description: "Bootloader accepts unsigned images.",
      affected_components: ["COMP-boot"],
      mitigations: ["MIT-secure-boot"],
    },
    links: [],
    cache: freshCache,
  };
}

function documentWarm() {
  return {
    projectId: "proj_1",
    projectVersionId: "version-1",
    kind: "document",
    key: DOC_ID,
    label: "BCM6755 datasheet.pdf",
    fields: {
      sha256: DOC_ID,
      path: "product-security/documents/a…-BCM6755.pdf",
      docKind: "datasheet",
      mimeType: "application/pdf",
      bytes: 1024,
      withdrawn: false,
      needsOcr: false,
      uploadedAt: "2026-08-15T00:00:00.000Z",
      retention: "plugin-local",
    },
    links: [],
    cache: freshCache,
  };
}

function emptyTaraCanvasPage() {
  return {
    items: [],
    total: 0,
    next: null,
    cache: freshCache,
  };
}

function matrixCell(requirementId: string, tier: string) {
  return {
    requirementId,
    tier,
    state: "mapped_not_run" as const,
    checkCount: 0,
    requiredCount: 0,
    latestAt: null,
    runIds: [] as string[],
  };
}

function matrixPage(pageSize: number) {
  return {
    items: Array.from({ length: Math.min(pageSize, 3) }, (_, index) => {
      const requirementId = `REQ-${index}`;
      return {
        projectId: "proj_1",
        projectVersionId: "version-1",
        kind: "verificationMatrixRow",
        key: requirementId,
        label: requirementId,
        fields: {
          row: {
            requirementId,
            title: `Requirement ${index}`,
            pattern: "ubiquitous",
            requirementType: "security",
            priority: "P1",
            stale: false,
            unknownCheckCount: 0,
            suppressedCheckCount: 0,
            cells: {
              static: matrixCell(requirementId, "static"),
              emulation: matrixCell(requirementId, "emulation"),
              hil: matrixCell(requirementId, "hil"),
              manual: matrixCell(requirementId, "manual"),
              hardware: matrixCell(requirementId, "hardware"),
            },
          },
          rollup: {
            requirements: 3,
            verified: 0,
            failed: 0,
            error: 0,
            inconclusive: 0,
            running: 0,
            pending: 3,
            skipped: 0,
          },
        },
        cache: freshCache,
      };
    }),
    total: 3,
    next: null,
    cache: freshCache,
  };
}

function matrixInputPageSize(input: unknown): number {
  if (typeof input !== "object" || input === null) return 200;
  const pageSize = Reflect.get(input, "pageSize");
  return typeof pageSize === "number" ? pageSize : 200;
}

function matrixInputText(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const filters = Reflect.get(input, "filters");
  if (typeof filters !== "object" || filters === null) return null;
  const text = Reflect.get(filters, "text");
  return typeof text === "string" ? text : null;
}

describe("WP-61 directives (all twelve)", () => {
  it("registers exactly twelve ids with registry parity", async () => {
    const app = await loadPluginApp(() => import("../../../app.js"));
    const registered = app.messageDirectives.map((directive) => directive.id);
    expect(registered.sort()).toEqual([...REGISTERED_DIRECTIVE_IDS].sort());
    expect(registered).toHaveLength(12);
    expect(registered.sort()).toEqual([...DIRECTIVE_IDS].sort());
    for (const id of registered) {
      expect(AGENT_SURFACE.directives).toContain(id);
    }
    expect(new Set([...PR1_DIRECTIVE_IDS, ...PR2_DIRECTIVE_IDS])).toEqual(
      new Set(REGISTERED_DIRECTIVE_IDS),
    );
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
      syncPlan: () => planWarm(),
      triageSummaryGet: () => triageWarm(),
      taraGet: () => threatWarm(),
      documentsGet: () => documentWarm(),
      taraScopeResolve: resolveTestTaraScope,
      taraCanvasList: () => emptyTaraCanvasPage(),
      verificationsMatrix: (input: unknown) =>
        matrixPage(matrixInputPageSize(input)),
      verificationMatrixPreferenceGet: () => ({ showManual: false }),
      forgeJobCreate: forge,
      forgeJobStatus: forge,
      forgeCompute: forge,
    };

    const cases: Array<{
      id: (typeof REGISTERED_DIRECTIVE_IDS)[number];
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
      { id: "fs-plan", attributes: { id: PLAN_ID } },
      { id: "fs-triage-summary", attributes: { id: TRIAGE_RUN_ID } },
      { id: "fs-threat", attributes: { id: "THREAT-22" } },
      { id: "fs-doc", attributes: { id: DOC_ID } },
      { id: "fs-canvas", attributes: { focus: "COMP-httpd" } },
      { id: "fs-matrix", attributes: { filter: "status:failed" } },
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
      cleanup();
    }
    expect(forge).not.toHaveBeenCalled();
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

  it("PR2 card directives render warm and navigate to owner panels", async () => {
    const app = await loadPluginApp(() => import("../../../app.js"));

    const plan = app.messageDirectives.find((d) => d.id === "fs-plan")!;
    const warmPlan = renderSlot(plan, messageProps({ id: PLAN_ID }), {
      context: { projectId: "proj_1" },
      rpc: { syncPlan: () => planWarm() },
    });
    expect(await warmPlan.findByLabelText(`Sync plan ${PLAN_ID}`)).toBeTruthy();
    fireEvent.click(warmPlan.getByRole("button", { name: "Open in Sync" }));
    expect(warmPlan.inspection.navigateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "toPluginPanel",
          path: "sync",
          options: expect.objectContaining({
            subPath: `plan/${PLAN_ID}`,
          }),
        }),
      ]),
    );
    cleanup();

    const triage = app.messageDirectives.find(
      (d) => d.id === "fs-triage-summary",
    )!;
    const warmTriage = renderSlot(
      triage,
      messageProps({ id: TRIAGE_RUN_ID, version: "version-1" }),
      {
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
          triageSummaryGet: () => triageWarm(),
        },
      },
    );
    expect(
      await warmTriage.findByLabelText(`Triage summary ${TRIAGE_RUN_ID}`),
    ).toBeTruthy();
    cleanup();

    const threat = app.messageDirectives.find((d) => d.id === "fs-threat")!;
    const warmThreat = renderSlot(threat, messageProps({ id: "THREAT-22" }), {
      context: { projectId: "proj_1" },
      rpc: { taraGet: () => threatWarm() },
    });
    expect(await warmThreat.findByLabelText("Threat THREAT-22")).toBeTruthy();
    cleanup();

    const doc = app.messageDirectives.find((d) => d.id === "fs-doc")!;
    const warmDoc = renderSlot(doc, messageProps({ id: DOC_ID }), {
      context: { projectId: "proj_1" },
      rpc: { documentsGet: () => documentWarm() },
    });
    expect(await warmDoc.findByText("BCM6755 datasheet.pdf")).toBeTruthy();
    cleanup();

    const coldPlan = renderSlot(plan, messageProps({ id: PLAN_ID }, null), {
      context: { projectId: null },
    });
    expect(await coldPlan.findByText("Choose a project")).toBeTruthy();
  });

  it("canvas lazy chunk has open-in-panel affordance and no mutation control", async () => {
    const app = await loadPluginApp(() => import("../../../app.js"));
    const canvas = app.messageDirectives.find((d) => d.id === "fs-canvas")!;
    const preferenceSet = vi.fn();
    const layoutSave = vi.fn();
    const slot = renderSlot(
      canvas,
      messageProps({ focus: "COMP-httpd", height: "420" }),
      {
        context: { projectId: "proj_1" },
        rpc: {
          taraScopeResolve: resolveTestTaraScope,
          taraCanvasList: () => emptyTaraCanvasPage(),
          canvasLayoutSave: layoutSave,
          verificationMatrixPreferenceSet: preferenceSet,
        },
      },
    );
    expect(await slot.findByText("No architecture model yet")).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", { name: "Open in Product Security" }),
    );
    expect(slot.inspection.navigateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "toPluginPanel",
          path: "product-security",
          options: expect.objectContaining({
            subPath: "tara/nodes/COMP-httpd",
          }),
        }),
      ]),
    );
    expect(layoutSave).not.toHaveBeenCalled();
    expect(preferenceSet).not.toHaveBeenCalled();
    expect(
      slot.inspection.rpcCalls.some(
        (call) => call.method === "canvasLayoutSave",
      ),
    ).toBe(false);
  });

  it("matrix directive caps at 15 rows and never preference-writes", async () => {
    const app = await loadPluginApp(() => import("../../../app.js"));
    const matrix = app.messageDirectives.find((d) => d.id === "fs-matrix")!;
    const preferenceSet = vi.fn();
    const slot = renderSlot(matrix, messageProps({ filter: "status:failed" }), {
      context: { projectId: "proj_1" },
      rpc: {
        verificationMatrixPreferenceGet: () => ({ showManual: false }),
        verificationMatrixPreferenceSet: preferenceSet,
        verificationsMatrix: (input: unknown) => {
          expect(matrixInputPageSize(input)).toBe(MATRIX_DIRECTIVE_MAX_ROWS);
          expect(matrixInputText(input)).toBe("status:failed");
          return matrixPage(matrixInputPageSize(input));
        },
      },
    });
    await waitFor(() => {
      expect(
        slot.inspection.rpcCalls.some(
          (call) => call.method === "verificationsMatrix",
        ),
      ).toBe(true);
    });
    const manual = slot.queryByLabelText(/Manual evidence/iu);
    if (manual) {
      fireEvent.click(manual);
    }
    expect(preferenceSet).not.toHaveBeenCalled();
    expect(
      slot.inspection.rpcCalls.some(
        (call) => call.method === "verificationMatrixPreferenceSet",
      ),
    ).toBe(false);
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
