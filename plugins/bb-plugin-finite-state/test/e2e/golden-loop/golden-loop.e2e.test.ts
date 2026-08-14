// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { createFakePluginHost } from "@bb/plugin-sdk/testing";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@bb/plugin-sdk/testing/app";
import type Database from "better-sqlite3";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertion, fileAssertion } from "./assertions.js";
import { createGoldenLoopHarness, type GoldenLoopHarness } from "./harness.js";
import { semanticReport } from "./reporter.js";
import { GOLDEN_LOOP_BEATS, type GoldenLoopBeat } from "./scenario.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../../..");
const FIXTURE_ROOT = resolve(import.meta.dirname, "../../mock-remote/fixtures");
const WORKSPACE_PROJECT_ID = "workspace-golden-loop";
const BENCH_VERSION = "golden-bench-version";
const DIGEST = "a".repeat(64);

interface Runtime {
  host: ReturnType<typeof createFakePluginHost>;
  db: Database.Database;
  worktree: string;
  projectId: string;
  findingVersion: string;
  bomVersion: string;
  fs193Version: string;
  findings: Map<string, Record<string, unknown>>;
  versions: Map<string, Record<string, unknown>>;
  evidence: Map<string, unknown>;
  failSbom: boolean;
  human: GoldenLoopHarness["human"] | null;
}

function human(runtime: Runtime): GoldenLoopHarness["human"] {
  if (runtime.human === null) {
    throw new Error("Golden Loop human actions are not initialized");
  }
  return runtime.human;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is not a string`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} is not a number`);
  return value;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function metadata(number: number) {
  const beat = GOLDEN_LOOP_BEATS.find(
    (candidate) => candidate.number === number,
  );
  if (!beat) throw new Error(`Missing Golden Loop metadata for beat ${number}`);
  return beat;
}

function successfulCli(value: unknown): boolean {
  const result = object(value, "CLI result");
  return result["exitCode"] === 0 && result["stderr"] === "";
}

function cliContext() {
  return { projectId: WORKSPACE_PROJECT_ID, threadId: "thread-golden-loop" };
}

async function ensureFindingPull(runtime: Runtime): Promise<void> {
  if (runtime.evidence.has("finding-pull")) return;
  const result = await runtime.host.harness.behavior.callRpc("syncPull", {
    workspaceProjectId: WORKSPACE_PROJECT_ID,
    projectId: runtime.projectId,
    projectVersionId: runtime.findingVersion,
    kinds: ["finding"],
  });
  runtime.evidence.set("finding-pull", result);
}

async function triageTargets(runtime: Runtime, findingIds: readonly string[]) {
  await ensureFindingPull(runtime);
  return object(
    await runtime.host.harness.behavior.callRpc("triageTargetsRead", {
      workspaceProjectId: WORKSPACE_PROJECT_ID,
      platformProjectId: runtime.projectId,
      projectVersionId: runtime.findingVersion,
      selection: { mode: "exact", findingIds },
      continuation: null,
    }),
    "triage target page",
  );
}

function decision(target: unknown, reason: string) {
  const item = object(target, "triage target");
  const evidence =
    typeof item["evidence"] === "string" && item["evidence"].length > 0
      ? item["evidence"]
      : typeof item["reasonSeed"] === "string" && item["reasonSeed"].length > 0
        ? item["reasonSeed"]
        : "Golden Loop cached finding evidence";
  return {
    findingId: string(item["findingId"], "finding id"),
    stableKey: string(item["stableKey"], "stable key"),
    status: "NOT_AFFECTED",
    justification: "CODE_NOT_REACHABLE",
    response: null,
    reason,
    evidence,
    pin: "exact_version",
    expectedSha256:
      typeof item["expectedSha256"] === "string"
        ? item["expectedSha256"]
        : null,
  };
}

function seedBench(runtime: Runtime): void {
  runtime.db
    .prepare(
      `INSERT OR IGNORE INTO pull_generation
       (project_id, project_version_id, generation_id, status,
        requested_kinds_json, started_at, completed_at, accepted_at)
       VALUES (?, ?, 'golden-bench-generation', 'accepted',
               '["verificationRun"]', ?, ?, ?)`,
    )
    .run(
      runtime.projectId,
      BENCH_VERSION,
      "2026-08-14T12:00:00.000Z",
      "2026-08-14T12:00:00.000Z",
      "2026-08-14T12:00:00.000Z",
    );
  runtime.db
    .prepare(
      `INSERT OR IGNORE INTO sync_state
       (project_id, project_version_id, entity_kind, accepted_generation_id,
        base_revision, last_pull)
       VALUES (?, ?, 'verificationRun', 'golden-bench-generation', 1, ?)`,
    )
    .run(runtime.projectId, BENCH_VERSION, "2026-08-14T12:00:00.000Z");
  runtime.db
    .prepare(
      `INSERT OR IGNORE INTO workspace_platform_project_binding
       (workspace_project_id, platform_project_id) VALUES (?, ?)`,
    )
    .run(WORKSPACE_PROJECT_ID, runtime.projectId);
  runtime.db
    .prepare(
      `INSERT OR IGNORE INTO firmware_mounts
       (project_id, project_version_id, generation_id, source, state,
        input_sha256, artifact_hash, root_path, file_count,
        materialized_files, error_count, pulled_at)
       VALUES (?, ?, 'golden-bench-generation', 'standalone_unpack',
               'metadata_only', ?, NULL, '/golden/firmware', 0, 0, 0, ?)`,
    )
    .run(runtime.projectId, BENCH_VERSION, DIGEST, "2026-08-14T12:00:00.000Z");
}

async function ensureSbomPull(runtime: Runtime): Promise<void> {
  if (runtime.evidence.has("sbom-pull")) return;
  const result = await runtime.host.harness.behavior.runCli(
    [
      "finite-state",
      "pull",
      "sbomComponent",
      "--project",
      runtime.projectId,
      "--version",
      runtime.bomVersion,
      "--json",
    ],
    cliContext(),
  );
  if (!successfulCli(result)) {
    throw new Error(
      `Initial SBOM pull failed: ${object(result, "result")["stderr"]}`,
    );
  }
  runtime.evidence.set("sbom-pull", result);
}

function beats(runtime: Runtime): GoldenLoopBeat[] {
  const list: GoldenLoopBeat[] = [
    {
      ...metadata(1),
      action: async ({ artifacts }) => {
        await ensureFindingPull(runtime);
        const reviewPull = await runtime.host.harness.behavior.callRpc(
          "syncPull",
          {
            workspaceProjectId: WORKSPACE_PROJECT_ID,
            projectId: runtime.projectId,
            projectVersionId: runtime.findingVersion,
            kinds: ["vexDecision"],
          },
        );
        const status = await runtime.host.harness.behavior.callRpc(
          "syncStatus",
          {
            projectId: runtime.projectId,
            projectVersionId: runtime.findingVersion,
            kinds: ["vexDecision"],
          },
        );
        const plan = await runtime.host.harness.behavior.callRpc("syncPlan", {
          projectId: runtime.projectId,
          projectVersionId: runtime.findingVersion,
          kinds: ["vexDecision"],
          pageSize: 100,
          continuation: null,
        });
        runtime.evidence.set("fs167-status", status);
        await artifacts.writeJson("sync-rpc-transcript.json", {
          pull: reviewPull,
          status,
        });
        await artifacts.writeJson("plan.json", plan);
      },
      assert: async () => {
        const pull = object(
          runtime.evidence.get("finding-pull"),
          "finding pull",
        );
        const kind = object(
          object(pull["kinds"], "pull kinds")["finding"],
          "finding counts",
        );
        return [
          assertion(
            "fresh finding pull accepted",
            number(kind["baseRows"], "base rows") === 3,
          ),
          assertion(
            "review status reads durable accepted state",
            runtime.evidence.has("fs167-status"),
          ),
        ];
      },
    },
    {
      ...metadata(2),
      action: async ({ artifacts }) => {
        const page = await triageTargets(runtime, [
          "golden-finding-1",
          "golden-finding-2",
        ]);
        const items = array(page["items"], "triage items");
        const written = await runtime.host.harness.behavior.callRpc(
          "triageDecisionsWrite",
          {
            workspaceProjectId: WORKSPACE_PROJECT_ID,
            platformProjectId: runtime.projectId,
            projectVersionId: runtime.findingVersion,
            decisions: items.map((item, index) =>
              decision(item, `Golden Loop bulk review rationale ${index + 1}`),
            ),
          },
        );
        const stale = await runtime.host.harness.behavior.callRpc(
          "triageDecisionsWrite",
          {
            workspaceProjectId: WORKSPACE_PROJECT_ID,
            platformProjectId: runtime.projectId,
            projectVersionId: runtime.findingVersion,
            decisions: items.map((item, index) =>
              decision(item, `Golden Loop stale retry rationale ${index + 1}`),
            ),
          },
        );
        runtime.evidence.set("fs168-written", written);
        runtime.evidence.set("fs168-stale", stale);
        await artifacts.writeJson("triage-rpc-transcript.json", {
          written,
          stale,
        });
      },
      assert: async ({ worktree }) => {
        const results = array(
          object(runtime.evidence.get("fs168-written"), "bulk write")[
            "results"
          ],
          "bulk results",
        ).map((item) => object(item, "bulk result"));
        const stale = array(
          object(runtime.evidence.get("fs168-stale"), "stale write")["results"],
          "stale results",
        ).map((item) => object(item, "stale result"));
        const files = await Promise.all(
          results.map((result) =>
            fileAssertion(
              worktree,
              string(result["file"], "triage file"),
              "status: NOT_AFFECTED",
            ),
          ),
        );
        return [
          assertion(
            "both bulk decisions wrote YAML",
            results.length === 2 &&
              results.every((item) => item["success"] === true),
          ),
          ...files,
          assertion(
            "stale bulk failure is visible and truthful",
            stale.every(
              (item) =>
                item["success"] === false &&
                item["code"] === "OVERLAY_CAS_CONFLICT",
            ),
          ),
        ];
      },
    },
    {
      ...metadata(3),
      setup: async () => seedBench(runtime),
      action: async ({ artifacts }) => {
        const started = await runtime.host.harness.behavior.callRpc(
          "benchRunStart",
          {
            projectId: runtime.projectId,
            projectVersionId: BENCH_VERSION,
            tier: "tier0",
            hostId: "golden-host",
          },
        );
        const runs = await runtime.host.harness.behavior.callRpc(
          "benchRunsList",
          {
            projectId: runtime.projectId,
            projectVersionId: BENCH_VERSION,
            pageSize: 20,
            continuation: null,
          },
        );
        runtime.evidence.set("fs171-started", started);
        runtime.evidence.set("fs171-runs", runs);
        await artifacts.writeJson("bench-dispatch-rpc.json", { started, runs });
      },
      assert: async () => {
        const rows = array(
          object(runtime.evidence.get("fs171-runs"), "runs")["items"],
          "run rows",
        );
        return [
          assertion(
            "registered runs list contains dispatched row",
            rows.length > 0,
          ),
        ];
      },
    },
    {
      ...metadata(4),
      action: async ({ artifacts }) => {
        await ensureSbomPull(runtime);
        runtime.failSbom = true;
        const failed = await runtime.host.harness.behavior.runCli(
          [
            "finite-state",
            "pull",
            "sbomComponent",
            "--project",
            runtime.projectId,
            "--version",
            runtime.bomVersion,
          ],
          cliContext(),
        );
        runtime.failSbom = false;
        const recovered = await runtime.host.harness.behavior.runCli(
          [
            "finite-state",
            "pull",
            "sbomComponent",
            "--project",
            runtime.projectId,
            "--version",
            runtime.bomVersion,
            "--json",
          ],
          cliContext(),
        );
        const page = await runtime.host.harness.behavior.callRpc(
          "bomSoftwareList",
          {
            projectId: runtime.projectId,
            projectVersionId: runtime.bomVersion,
            pageSize: 100,
            continuation: null,
            filters: {},
          },
        );
        runtime.evidence.set("fs172-failed", failed);
        runtime.evidence.set("fs172-recovered", recovered);
        runtime.evidence.set("fs172-page", page);
        await artifacts.writeJson("sbom-recovery-transcript.json", {
          failed,
          recovered,
          page,
        });
      },
      assert: async () => [
        assertion(
          "failed refresh is reported",
          object(runtime.evidence.get("fs172-failed"), "failed pull")[
            "exitCode"
          ] === 1,
        ),
        assertion(
          "retry publishes successfully",
          successfulCli(runtime.evidence.get("fs172-recovered")),
        ),
        assertion(
          "durable components remain readable",
          array(
            object(runtime.evidence.get("fs172-page"), "SBOM page")["items"],
            "components",
          ).length > 0,
        ),
      ],
    },
    {
      ...metadata(5),
      action: async ({ artifacts }) => {
        const template = runtime.versions.values().next().value;
        if (!template) throw new Error("Platform seed has no version template");
        runtime.versions.set(runtime.fs193Version, {
          ...template,
          id: runtime.fs193Version,
        });
        runtime.findings.set("fs193-valid-a", {
          id: "fs193-valid-a",
          projectVersionId: runtime.fs193Version,
          findingId: "CVE-2026-19300",
          component: {
            id: "fs193-component-a",
            name: "library-a",
            version: "1",
          },
        });
        runtime.findings.set("fs193-valid-b", {
          id: "fs193-valid-b",
          projectVersionId: runtime.fs193Version,
          findingId: "CVE-2026-19301",
          component: {
            id: "fs193-component-b",
            name: "library-b",
            version: "1",
          },
        });
        const pull = () =>
          runtime.host.harness.behavior.callRpc("syncPull", {
            workspaceProjectId: WORKSPACE_PROJECT_ID,
            projectId: runtime.projectId,
            projectVersionId: runtime.fs193Version,
            kinds: ["finding"],
          });
        await pull();
        for (const id of ["fs193-valid-a", "fs193-valid-b"])
          runtime.findings.delete(id);
        for (let index = 1; index <= 3; index += 1) {
          runtime.findings.set(`fs193-bad-${index}`, {
            id: `fs193-bad-${index}`,
            projectVersionId: runtime.fs193Version,
            findingId: `CVE-2026-1931${index}`,
            component: { id: `fs193-invalid-${index}`, version: "" },
          });
        }
        let failure = "";
        try {
          await pull();
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        const retained = await runtime.host.harness.behavior.callRpc(
          "findingsUiList",
          {
            projectId: runtime.projectId,
            projectVersionId: runtime.fs193Version,
            pageSize: 100,
            continuation: null,
            filters: {},
          },
        );
        for (let index = 1; index <= 3; index += 1)
          runtime.findings.delete(`fs193-bad-${index}`);
        runtime.findings.set("fs193-repaired", {
          id: "fs193-repaired",
          projectVersionId: runtime.fs193Version,
          findingId: "CVE-2026-19320",
          component: {
            id: "fs193-repaired-component",
            name: "repaired-library",
            version: "2",
          },
        });
        const recovered = await pull();
        const published = await runtime.host.harness.behavior.callRpc(
          "findingsUiList",
          {
            projectId: runtime.projectId,
            projectVersionId: runtime.fs193Version,
            pageSize: 100,
            continuation: null,
            filters: {},
          },
        );
        runtime.evidence.set("fs193", {
          failure,
          retained,
          recovered,
          published,
        });
        await artifacts.writeJson("quarantine-recovery.json", {
          failure,
          retained,
          recovered,
          published,
        });
      },
      assert: async () => {
        const evidence = object(
          runtime.evidence.get("fs193"),
          "FS-193 evidence",
        );
        const retained = array(
          object(evidence["retained"], "retained page")["items"],
          "retained rows",
        );
        const published = array(
          object(evidence["published"], "published page")["items"],
          "published rows",
        );
        return [
          assertion(
            "all-quarantined pull fails with truthful count",
            string(evidence["failure"], "failure").includes(
              "quarantined 3 fetched finding rows",
            ),
          ),
          assertion(
            "accepted generation remains visible",
            retained.length === 2,
          ),
          assertion(
            "same-kind repaired pull publishes",
            published.length === 1,
          ),
        ];
      },
    },
    {
      ...metadata(6),
      action: async ({ artifacts }) => {
        const page = await triageTargets(runtime, ["golden-finding-3"]);
        const target = array(page["items"], "single targets")[0];
        const written = object(
          await runtime.host.harness.behavior.callRpc("triageDecisionsWrite", {
            workspaceProjectId: WORKSPACE_PROJECT_ID,
            platformProjectId: runtime.projectId,
            projectVersionId: runtime.findingVersion,
            decisions: [
              decision(target, "Golden Loop single reviewed rationale"),
            ],
          }),
          "single write",
        );
        const success = object(
          array(written["results"], "single results")[0],
          "single result",
        );
        const undone = await runtime.host.harness.behavior.callRpc(
          "triageDecisionUndo",
          {
            workspaceProjectId: WORKSPACE_PROJECT_ID,
            platformProjectId: runtime.projectId,
            projectVersionId: runtime.findingVersion,
            findingId: success["findingId"],
            stableKey: success["stableKey"],
            token: success["undo"],
          },
        );
        const reread = await triageTargets(runtime, ["golden-finding-3"]);
        runtime.evidence.set("fs194", { written, undone, reread });
        await artifacts.writeJson("single-write-undo.json", {
          written,
          undone,
          reread,
        });
      },
      assert: async () => {
        const evidence = object(
          runtime.evidence.get("fs194"),
          "FS-194 evidence",
        );
        const result = object(
          array(object(evidence["written"], "write")["results"], "results")[0],
          "result",
        );
        const reread = object(
          array(object(evidence["reread"], "reread")["items"], "items")[0],
          "target",
        );
        return [
          assertion("single YAML write completes", result["success"] === true),
          assertion(
            "undo reverts the claimed decision",
            reread["prior"] === null,
          ),
        ];
      },
    },
    {
      ...metadata(7),
      expectedFailure: {
        task: "FS-201",
        reason:
          "requirement pull does not make the bench product-version selector reachable",
      },
      action: async ({ artifacts }) => {
        const pull = await runtime.host.harness.behavior.runCli(
          [
            "finite-state",
            "pull",
            "requirement",
            "--project",
            runtime.projectId,
            "--version",
            runtime.findingVersion,
            "--json",
          ],
          cliContext(),
        );
        const versions = await runtime.host.harness.behavior.callRpc(
          "benchProjectVersions",
          {
            projectId: WORKSPACE_PROJECT_ID,
          },
        );
        await artifacts.writeJson("fs201-pending.json", {
          marker: "EXPECTED_FAILURE",
          task: "FS-201",
          pull,
          versions,
        });
        const selected = object(versions, "bench versions")[
          "selectedProjectVersionId"
        ];
        if (selected !== runtime.findingVersion)
          throw new Error(
            "the requirement-pulled version is absent from the bench selector",
          );
        const run = await runtime.host.harness.behavior.callRpc(
          "benchRunStart",
          {
            projectId: runtime.projectId,
            projectVersionId: selected,
            tier: "tier0",
            hostId: "golden-host",
          },
        );
        runtime.evidence.set("fs201-unexpected-pass", run);
      },
      assert: async () => [
        assertion(
          "requirement-to-verdict loop completed",
          runtime.evidence.has("fs201-unexpected-pass"),
        ),
      ],
    },
    {
      ...metadata(8),
      action: async ({ artifacts }) => {
        await ensureSbomPull(runtime);
        const page = await runtime.host.harness.behavior.callRpc(
          "bomSoftwareList",
          {
            projectId: runtime.projectId,
            projectVersionId: runtime.bomVersion,
            pageSize: 100,
            continuation: null,
            filters: {},
          },
        );
        runtime.evidence.set("bom-page", page);
        await artifacts.writeJson("bom-page.json", page);
      },
      assert: async () => [
        assertion(
          "BOM inventory reads durable rows",
          array(
            object(runtime.evidence.get("bom-page"), "BOM page")["items"],
            "items",
          ).length > 0,
        ),
      ],
    },
    {
      ...metadata(9),
      action: async ({ artifacts }) => {
        const { architectureEntityPayload, parseArchitectureEntity } =
          await import("../../../lanes/product-security/canvas/editing/schema.js");
        const fields = architectureEntityPayload(
          parseArchitectureEntity("component", {
            slug: "golden-gateway",
            name: "Golden gateway",
            component_type: "software",
            criticality: "high",
            interfaces: [],
            technologies: ["typescript"],
            is_entry_point: true,
            stores_data: false,
          }),
        );
        const written = await runtime.host.harness.behavior.callRpc(
          "taraCommandApply",
          {
            projectId: WORKSPACE_PROJECT_ID,
            projectVersionId: null,
            operation: "create",
            kind: "component",
            fields,
            expectedContentSha256: null,
          },
        );
        const page = await runtime.host.harness.behavior.callRpc("taraList", {
          projectId: WORKSPACE_PROJECT_ID,
          projectVersionId: null,
          kind: "component",
          filters: {},
          pageSize: 50,
          continuation: null,
        });
        runtime.evidence.set("canvas", { written, page });
        await artifacts.writeJson("canvas-rpc.json", { written, page });
      },
      assert: async ({ worktree }) => {
        const written = object(
          object(runtime.evidence.get("canvas"), "canvas evidence")["written"],
          "canvas write",
        );
        return [
          assertion(
            "canvas RPC reads authored component",
            array(
              object(
                object(runtime.evidence.get("canvas"), "canvas")["page"],
                "page",
              )["items"],
              "items",
            ).some(
              (item) => object(item, "canvas row")["key"] === "golden-gateway",
            ),
          ),
          await fileAssertion(
            worktree,
            "product-security/architecture/components/golden-gateway.yaml",
            "slug: golden-gateway",
          ),
          assertion(
            "canvas write returns review diff",
            typeof written["diffSummary"] === "string",
          ),
        ];
      },
    },
    {
      ...metadata(10),
      action: async ({ artifacts }) => {
        await ensureFindingPull(runtime);
        const before = runtime.host.harness.inspection.realtimeSignals.length;
        await runtime.host.harness.behavior.callRpc("syncPull", {
          workspaceProjectId: WORKSPACE_PROJECT_ID,
          projectId: runtime.projectId,
          projectVersionId: runtime.findingVersion,
          kinds: ["finding"],
        });
        const signals =
          runtime.host.harness.inspection.realtimeSignals.slice(before);
        const durable = await runtime.host.harness.behavior.callRpc(
          "findingsUiList",
          {
            projectId: runtime.projectId,
            projectVersionId: runtime.findingVersion,
            pageSize: 100,
            continuation: null,
            filters: {},
          },
        );
        runtime.evidence.set("realtime", { signals, durable });
        await artifacts.writeJson("realtime-refetch.json", {
          signals,
          durable,
        });
      },
      assert: async () => {
        const evidence = object(
          runtime.evidence.get("realtime"),
          "realtime evidence",
        );
        return [
          assertion(
            "publication emits refetch hint",
            array(evidence["signals"], "signals").some(
              (signal) =>
                object(signal, "signal")["channel"] === "findings:changed",
            ),
          ),
          assertion(
            "assertion refetches durable state",
            array(object(evidence["durable"], "durable page")["items"], "rows")
              .length === 3,
          ),
        ];
      },
    },
    {
      ...metadata(11),
      setup: async () => seedBench(runtime),
      action: async ({ artifacts }) => {
        const runs = await runtime.host.harness.behavior.callRpc(
          "benchRunsList",
          {
            projectId: runtime.projectId,
            projectVersionId: BENCH_VERSION,
            pageSize: 20,
            continuation: null,
          },
        );
        const verdict = await runtime.host.harness.behavior.callRpc(
          "benchOtaVerdictGet",
          {
            projectId: runtime.projectId,
            pvId: BENCH_VERSION,
            digest: DIGEST,
          },
        );
        runtime.evidence.set("bench-evidence", { runs, verdict });
        await artifacts.writeJson("run-evidence.json", { runs, verdict });
      },
      assert: async () => {
        const evidence = object(
          runtime.evidence.get("bench-evidence"),
          "bench evidence",
        );
        return [
          assertion(
            "run evidence remains queryable",
            Array.isArray(object(evidence["runs"], "runs")["items"]),
          ),
          assertion(
            "verdict is explicit",
            ["INCONCLUSIVE", "SAFE_TO_OTA", "NOT_SAFE"].includes(
              string(
                object(evidence["verdict"], "verdict")["verdict"],
                "verdict state",
              ),
            ),
          ),
        ];
      },
    },
    {
      ...metadata(12),
      action: async ({ artifacts }) => {
        seedBench(runtime);
        const { VerdictCard } =
          await import("../../../lanes/bench/app/verdict-card.js");
        const slot = renderSlot(
          { component: VerdictCard },
          { id: BENCH_VERSION, projectId: runtime.projectId, digest: DIGEST },
          {
            context: { projectId: runtime.projectId },
            rpc: {
              benchOtaVerdictGet: (input) =>
                runtime.host.harness.behavior.callRpc(
                  "benchOtaVerdictGet",
                  input,
                ),
            },
          },
        );
        await slot.findByLabelText(/OTA verdict:/u);
        const dom = slot.container.innerHTML;
        runtime.evidence.set("dom", dom);
        await artifacts.writeText("demo-card.dom.html", dom);
        slot.unmount();
      },
      assert: async () => [
        assertion(
          "demo card renders observable verdict state",
          string(runtime.evidence.get("dom"), "DOM snapshot").includes(
            "OTA verdict",
          ),
        ),
      ],
    },
    {
      ...metadata(13),
      action: async ({ git, worktree, artifacts }) => {
        await writeFile(
          join(worktree, "golden-loop-change.txt"),
          "reviewable change\n",
          "utf8",
        );
        await git.run(["add", "golden-loop-change.txt"]);
        await git.run(["commit", "-m", "Golden Loop reviewable change"]);
        const show = await git.run(["show", "--stat", "--oneline", "HEAD"]);
        runtime.evidence.set("git-show", show.stdout);
        await artifacts.writeText("git-commit.txt", show.stdout);
      },
      assert: async () => [
        assertion(
          "deterministic commit is reviewable",
          string(runtime.evidence.get("git-show"), "git show").includes(
            "Golden Loop reviewable change",
          ),
        ),
      ],
    },
    {
      ...metadata(14),
      action: async ({ artifacts }) => {
        await human(runtime).reviewDiff({ beat: 14, source: "git diff" });
        let refusal = "";
        try {
          await runtime.host.harness.behavior.callAgentTool("human.push", {});
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error);
        }
        await human(runtime).push({
          beat: 14,
          destination: "local rehearsal remote",
        });
        runtime.evidence.set("human-boundary", refusal);
        await artifacts.writeJson("human-boundary.json", {
          agentRefusal: refusal,
          humanActions: ["reviewDiff", "push"],
        });
      },
      assert: async () => [
        assertion(
          "agent cannot invoke human push",
          string(runtime.evidence.get("human-boundary"), "agent refusal")
            .length > 0,
        ),
        assertion(
          "human tools are absent from registry",
          !runtime.host.harness.inspection.registrations.agentTools.some(
            ({ name }) => name.startsWith("human."),
          ),
        ),
      ],
    },
  ];
  return list;
}

async function createRun(
  runLabel: "run-1" | "run-2",
): Promise<Readonly<{ harness: GoldenLoopHarness; runtime: Runtime }>> {
  vi.resetModules();
  installTestPluginRuntime();
  let worktree = "";
  let runtime: Runtime | undefined;
  const harness = await createGoldenLoopHarness({
    repositoryRoot: REPOSITORY_ROOT,
    ...(process.env["GOLDEN_LOOP_EVIDENCE_DIR"]
      ? {
          evidenceDirectory: join(
            process.env["GOLDEN_LOOP_EVIDENCE_DIR"],
            runLabel,
          ),
        }
      : {}),
    scenario: beats(
      new Proxy({} as Runtime, {
        get(_target, property) {
          if (!runtime)
            throw new Error(
              `Golden Loop runtime unavailable for ${String(property)}`,
            );
          return Reflect.get(runtime, property);
        },
        set(_target, property, value) {
          if (!runtime)
            throw new Error(
              `Golden Loop runtime unavailable for ${String(property)}`,
            );
          return Reflect.set(runtime, property, value);
        },
      }),
    ),
    host: {
      sdk: {
        projects: {
          get: ({ projectId }) => ({
            id: projectId,
            kind: "standard" as const,
            name: "Golden Loop",
            gitRemoteUrl: null,
            createdAt: 1,
            updatedAt: 1,
            sources: [
              {
                id: "golden-source",
                projectId,
                type: "local_path" as const,
                hostId: "golden-host",
                path: worktree,
                isDefault: true,
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          }),
        },
        threads: {
          get: async () => ({
            id: "thread-golden-loop",
            projectId: WORKSPACE_PROJECT_ID,
            environmentId: "environment-golden-loop",
            title: "Golden Loop",
            status: "active" as const,
            agentStatus: null,
            archived: false,
            preview: "",
            createdAt: 1,
            updatedAt: 1,
            unread: false,
            provider: null,
            model: null,
            reasoningEffort: null,
            serviceTier: null,
            permissionMode: null,
            interactionMode: null,
            parentThreadId: null,
            source: null,
            headSha: null,
            branch: null,
            worktreePath: worktree,
            error: null,
            labels: [],
            attachments: [],
          }),
          spawn: async () => ({ id: "thread-bench-golden" }),
        },
        environments: {
          get: async () => ({
            id: "environment-golden-loop",
            projectId: WORKSPACE_PROJECT_ID,
            path: worktree,
            hostId: "golden-host",
          }),
        },
        hosts: {
          list: async () => [
            {
              id: "golden-host",
              name: "Golden host",
              type: "persistent" as const,
              status: "connected" as const,
              maxPermissionMode: "full" as const,
              lastSeenAt: 1,
              lastRejectedProtocolVersion: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
        files: {
          async list({ path }) {
            const entries = await readdir(path, { withFileTypes: true }).catch(
              () => [],
            );
            return {
              files: entries
                .filter((entry) => entry.isFile())
                .map((entry) => ({
                  path: join(path, entry.name),
                  name: entry.name,
                })),
              truncated: false,
            };
          },
          async read({ path }) {
            const content = await readFile(path, "utf8");
            return {
              content,
              contentEncoding: "utf8" as const,
              sha256: sha256(content),
            };
          },
          async write({ path, content, expectedSha256 }) {
            const existing = await readFile(path, "utf8").catch(() => null);
            const currentSha256 = existing === null ? null : sha256(existing);
            if (currentSha256 !== expectedSha256)
              return { outcome: "conflict" as const, currentSha256 };
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, content, "utf8");
            return {
              outcome: "written" as const,
              sha256: sha256(content),
              sizeBytes: Buffer.byteLength(content),
            };
          },
        },
      },
    },
    configure: async ({ bb, host, worktree: configuredWorktree }) => {
      worktree = configuredWorktree;
      const [
        contextModule,
        platformClientModule,
        asClientModule,
        mockModule,
        platformStateModule,
        platformRegisterModule,
        asRegisterModule,
        syncModule,
        findingsModule,
        bomModule,
        benchModule,
        productModule,
        actionsModule,
      ] = await Promise.all([
        import("../../../lib/context.js"),
        import("../../../lib/remote/platform/client.js"),
        import("../../../lib/remote/assurance-studio/client.js"),
        import("../../mock-remote/server.js"),
        import("../../mock-remote/platform/state.js"),
        import("../../mock-remote/platform/register.js"),
        import("../../mock-remote/assurance-studio/register.js"),
        import("../../../lanes/sync/register.js"),
        import("../../../lanes/findings/register.js"),
        import("../../../lanes/bom/register.js"),
        import("../../../lanes/bench/register.js"),
        import("../../../lanes/product-security/register.js"),
        import("../../../lanes/agentic/tools/actions.js"),
      ]);
      const state = platformStateModule.createMockPlatformState(FIXTURE_ROOT);
      const templateVersion = state.versions.values().next().value;
      const templateProject = state.projects.values().next().value;
      if (!templateVersion || !templateProject)
        throw new Error("Mock Platform seed is empty");
      const projectId = string(templateProject["id"], "Platform project id");
      const bomVersion = string(templateVersion["id"], "Platform version id");
      const findingVersion = "golden-finding-version";
      state.versions.set(findingVersion, {
        ...templateVersion,
        id: findingVersion,
      });
      state.findings.clear();
      for (let index = 1; index <= 3; index += 1) {
        state.findings.set(`golden-finding-${index}`, {
          id: `golden-finding-${index}`,
          projectVersionId: findingVersion,
          findingId: `CVE-2026-6500${index}`,
          component: {
            id: `golden-component-${index}`,
            name: `golden-component-${index}`,
            version: "1.0.0",
          },
          severity: index === 1 ? "critical" : "high",
          reachability: {
            verdict: "unreachable",
            factors: [
              { label: "Call graph", value: "no path", source: "analysis" },
            ],
          },
        });
      }
      const remote = mockModule.createMockRemote({
        platformToken: "golden-platform-token",
        assuranceStudioKey: "golden-as-key",
        fixtureRoot: FIXTURE_ROOT,
        register(service, registry) {
          if (service === "platform")
            platformRegisterModule.registerPlatformHandlers(registry, state);
          else
            asRegisterModule.registerMockAssuranceStudio(
              registry,
              FIXTURE_ROOT,
              { now: () => "2026-08-14T12:00:00.000Z" },
            );
        },
      });
      const platform = new platformClientModule.PlatformClient({
        baseUrl: "http://platform.mock",
        token: "golden-platform-token",
        async fetch(input, init) {
          const url = new URL(
            input instanceof Request ? input.url : input.toString(),
          );
          if (runtime?.failSbom && url.pathname.includes("/components")) {
            return Response.json(
              { message: "induced recoverable SBOM failure" },
              { status: 503 },
            );
          }
          return remote.platform.fetch(input, init);
        },
      });
      const assuranceStudio = new asClientModule.AssuranceStudioClient({
        baseUrl: "http://assurance-studio.mock",
        apiKey: "golden-as-key",
        fetch: remote.assuranceStudio.fetch,
      });
      const ctx = contextModule.createPluginContext(bb);
      ctx.service("remote-services", () => ({
        platform,
        assuranceStudio,
        forgeCompute: null,
      }));
      benchModule.registerBench(bb, ctx);
      ctx.service("bench.cli", () => ({
        run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }));
      syncModule.registerSync(bb, ctx);
      findingsModule.registerFindings(bb, ctx);
      productModule.registerProductSecurity(bb, ctx);
      bomModule.registerBom(bb, ctx);
      actionsModule.registerActionTools(bb, ctx);
      bb.onDispose(async () => {
        platform.close();
        assuranceStudio.close();
        await remote.close();
      });
      runtime = {
        host,
        db: ctx.db(),
        worktree,
        projectId,
        findingVersion,
        bomVersion,
        fs193Version: "golden-fs193-version",
        findings: state.findings,
        versions: state.versions,
        evidence: new Map(),
        failSbom: false,
        human: null,
      };
    },
    human: {
      reviewDiff: async () => {},
      resolveConflict: async () => {},
      push: async () => {},
    },
  });
  if (!runtime)
    throw new Error("Golden Loop configure did not initialize runtime");
  runtime.human = harness.human;
  return { harness, runtime };
}

afterEach(() => cleanup());

describe.sequential("Golden Loop incremental acceptance", () => {
  it(
    "runs all fourteen ordered beats twice with the same semantic result",
    async () => {
      const callerBefore = await stat(join(REPOSITORY_ROOT, ".git"));
      const first = await createRun("run-1");
      const firstResults = await first.harness.runAll();
      expect(firstResults).toHaveLength(14);
      expect(firstResults.map(({ beat }) => beat)).toEqual(
        GOLDEN_LOOP_BEATS.map(({ number }) => number),
      );
      expect(firstResults.find(({ beat }) => beat === 7)).toMatchObject({
        status: "skipped",
      });
      expect(
        firstResults
          .filter(({ beat }) => beat !== 7)
          .every(({ status }) => status === "passed"),
      ).toBe(true);
      first.harness.assertNoExternalNetwork();
      const firstSemantic = semanticReport(first.harness.report!);
      await first.harness.dispose();

      const second = await createRun("run-2");
      const secondResults = await second.harness.runAll();
      expect(secondResults).toHaveLength(14);
      second.harness.assertNoExternalNetwork();
      expect(semanticReport(second.harness.report!)).toEqual(firstSemantic);
      expect(second.harness.report?.durationMs).toBeLessThan(15 * 60 * 1_000);
      await second.harness.dispose();
      expect(await stat(join(REPOSITORY_ROOT, ".git"))).toMatchObject({
        ino: callerBefore.ino,
      });
    },
    15 * 60 * 1_000,
  );

  it("rejects missing or duplicated beat modules before creating a run", async () => {
    const complete = new Map(
      GOLDEN_LOOP_BEATS.map((beat) => [beat.number, beat]),
    );
    expect(complete.size).toBe(14);
    expect(GOLDEN_LOOP_BEATS.map(({ number }) => number)).toEqual([
      ...complete.keys(),
    ]);
  });
});
