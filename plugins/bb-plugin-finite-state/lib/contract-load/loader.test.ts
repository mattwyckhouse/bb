import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createFakePluginHost,
  makeThreadResponse,
} from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPluginContext } from "../context.js";
import { AssuranceStudioClient } from "../remote/assurance-studio/client.js";
import { PlatformClient } from "../remote/platform/client.js";
import type { RemoteServices } from "../remote/types.js";
import { openStore, type Store } from "../store/index.js";
import { WORKSPACE_PLATFORM_PROJECT_PREDICATE } from "../store/project-scope.js";
import { MIGRATIONS } from "../store/schema.js";
import type { RequirementYamlV1 } from "../../lanes/product-security/requirements/cards/schema.js";
import { serializeRequirement } from "../../lanes/product-security/requirements/cards/adapter.js";
import { registerProductSecurity } from "../../lanes/product-security/register.js";
import { registerBench } from "../../lanes/bench/register.js";
import { registerSync } from "../../lanes/sync/register.js";
import { parseYaml } from "../../lanes/sync/serialize/yaml.js";
import { registerRepoContractLoadService } from "./index.js";
import {
  contractLoadScope,
  contractLoadSidecarName,
  loadRepoContract,
} from "./loader.js";
import {
  computeProjectionKey,
  repoContractIdentity,
} from "./projection-key.js";

vi.mock("../../lanes/sync/serialize/yaml.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../lanes/sync/serialize/yaml.js")>();
  return { ...original, parseYaml: vi.fn(original.parseYaml) };
});

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const REAL_TRIAGE_FIXTURE = resolve(
  import.meta.dirname,
  "../../test/e2e/golden-loop/seed/worktree/.fs/triage/project-ax3000-demo/httpd-1.yaml",
);

interface LoadedFixture {
  readonly dbPath: string;
  readonly root: string;
  readonly scope: ReturnType<typeof contractLoadScope>;
  readonly store: Store;
}

function requirement(
  description = "Reject unsigned firmware before installation.",
): RequirementYamlV1 {
  return {
    schema: "fs-requirement/v1",
    id: "REQ-OFFLINE",
    req_type: "security",
    priority: "P1",
    status: "approved",
    ears: {
      pattern: "ubiquitous",
      text: "The gateway SHALL reject unsigned firmware",
      parts: {
        system: "gateway",
        response: "reject unsigned firmware",
      },
    },
    rationale: "The update boundary must fail closed.",
    source_description: description,
    mitigations: ["signed-update"],
    controls: ["secure-boot"],
    standards: ["iec-62443-4-2"],
    verification: [
      {
        check: "check-firmware-signature",
        method: "binary_analysis",
        tier: "static",
        required: true,
        coverage: "full",
        pass_criteria: "Every accepted image has a trusted signature.",
        fail_criteria: "An unsigned image is accepted.",
        expected_evidence: ["signature verification report"],
      },
    ],
  };
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function initializeRepository(
  tag: string,
  options: { fullCorpus?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `fs-contract-${tag}-`));
  temporaryRoots.push(root);
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Contract Loader Test");
  await git(root, "config", "user.email", "contract-loader@example.invalid");
  await mkdir(join(root, "product-security", "requirements"), {
    recursive: true,
  });
  await writeFile(
    join(root, "product-security", "requirements", "REQ-OFFLINE.yaml"),
    serializeRequirement(requirement()),
  );
  if (options.fullCorpus === true) {
    await mkdir(join(root, "product-security", "threats"), { recursive: true });
    await writeFile(
      join(root, "product-security", "threats", "threat-offline.yaml"),
      `slug: threat-offline
name: Offline threat
category: spoofing
threat_source: manual
severity: high
affected_components: []
affected_assets: []
dataflows: []
mitigations: []
assumptions: []
`,
    );
    await writeFile(
      join(root, "product-security", "threats", "malformed.yaml"),
      "slug: [unterminated\n",
    );
    const triageDirectory = join(root, ".fs", "triage", "project-ax3000-demo");
    await mkdir(triageDirectory, { recursive: true });
    await copyFile(REAL_TRIAGE_FIXTURE, join(triageDirectory, "httpd-1.yaml"));
  }
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", "contract fixture");
  return root;
}

function openFileStore(dbPath: string): Store {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  for (const migration of MIGRATIONS) db.exec(migration);
  return {
    db,
    tx<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}

async function fixture(
  tag: string,
  fullCorpus = false,
): Promise<LoadedFixture> {
  const root = await initializeRepository(tag, { fullCorpus });
  const databaseDirectory = await mkdtemp(
    join(tmpdir(), `fs-contract-db-${tag}-`),
  );
  temporaryRoots.push(databaseDirectory);
  const dbPath = join(databaseDirectory, "projection.db");
  const store = openFileStore(dbPath);
  const identity = await repoContractIdentity(root);
  return {
    dbPath,
    root,
    scope: contractLoadScope(identity.repositoryDigest),
    store,
  };
}

function normalizedProjection(store: Store): Record<string, unknown> {
  return {
    base: store.db
      .prepare(
        `SELECT base.project_id, base.project_version_id, base.entity_kind,
                base.entity_key, base.payload, base.content_hash
           FROM base_snapshot base
           JOIN sync_state state
             ON state.project_id = base.project_id
            AND state.project_version_id = base.project_version_id
            AND state.entity_kind = base.entity_kind
            AND state.accepted_generation_id = base.generation_id
          ORDER BY base.entity_kind, base.entity_key`,
      )
      .all(),
    checks: store.db
      .prepare(
        `SELECT code, name, check_type, category, pass_criteria,
                fail_criteria, parameters, raw
           FROM verification_checks
          ORDER BY code`,
      )
      .all(),
    mappings: store.db
      .prepare(
        `SELECT requirement_key, check_id, is_required, coverage_level,
                suppressed, raw
           FROM requirement_check_mappings
          ORDER BY requirement_key, check_id`,
      )
      .all(),
    rollups: store.db
      .prepare(
        `SELECT requirement_key, verification_status, total_checks,
                verified_checks, failed_checks, error_checks,
                inconclusive_checks, running_checks, pending_checks,
                skipped_checks, last_run_at
           FROM requirement_rollup
          ORDER BY requirement_key`,
      )
      .all(),
    overlay: store.db
      .prepare(
        `SELECT project_id, project_version_id, entity_kind, stable_key,
                cve, file_path, file_sha256, vex_status, vex_response,
                vex_justification, vex_reason, pin, provenance_by,
                provenance_at, evidence, sync_base, pushed_at, local_state
           FROM overlay_index
          ORDER BY project_id, project_version_id, stable_key`,
      )
      .all(),
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("repository contract loader", () => {
  it("loads the real offline corpus, skips unchanged YAML, and continues after a bad file", async () => {
    const value = await fixture("offline", true);
    const guardedFetch = vi.fn(() => {
      throw new Error("NETWORK_CALL_FORBIDDEN");
    });
    vi.stubGlobal("fetch", guardedFetch);
    const before = await computeProjectionKey(value.root);

    const first = await loadRepoContract(value.root, value.store, value.scope);
    expect(first).toMatchObject({
      rebuilt: true,
      entityCounts: {
        requirement: 1,
        threat: 1,
      },
    });
    expect(first.entityCounts["triage"]).toBeGreaterThan(0);
    expect(first.diagnostics).toEqual([
      expect.objectContaining({
        path: "product-security/threats/malformed.yaml",
        message: expect.stringContaining("line 2"),
      }),
    ]);
    expect(guardedFetch).not.toHaveBeenCalled();

    const parseSpy = vi.mocked(parseYaml);
    expect(parseSpy).toHaveBeenCalled();
    parseSpy.mockClear();
    const second = await loadRepoContract(value.root, value.store, value.scope);
    expect(second).toEqual({ ...first, rebuilt: false });
    expect(parseSpy).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
    expect(await computeProjectionKey(value.root)).toEqual(before);

    const visible = value.store.db
      .prepare(
        `SELECT DISTINCT s.project_id, s.project_version_id
           FROM sync_state s
          WHERE ${WORKSPACE_PLATFORM_PROJECT_PREDICATE}
            AND s.entity_kind = 'requirement'`,
      )
      .all("unrelated-bb-project");
    expect(visible).toEqual([
      {
        project_id: value.scope.projectId,
        project_version_id: value.scope.projectVersionId,
      },
    ]);
    expect(value.scope.projectVersionId).not.toBe("@project");
    expect(
      value.store.db
        .prepare(
          `SELECT code, check_type, category
             FROM verification_checks`,
        )
        .all(),
    ).toEqual([
      {
        code: "check-firmware-signature",
        check_type: "binary_analysis",
        category: "static",
      },
    ]);
    expect(
      value.store.db
        .prepare("SELECT COUNT(*) AS count FROM requirement_check_mappings")
        .get(),
    ).toEqual({ count: 1 });

    const generation = value.store.db
      .prepare(
        `SELECT generation_id, requested_kinds_json
           FROM pull_generation
          WHERE project_id = ? AND project_version_id = ? AND status = 'accepted'`,
      )
      .get(value.scope.projectId, value.scope.projectVersionId);
    expect(generation).toEqual({
      generation_id: expect.stringMatching(/^contract-load-[0-9a-f-]+$/u),
      requested_kinds_json: JSON.stringify([
        "asset",
        "attackPath",
        "checkParams",
        "component",
        "dataflow",
        "mitigation",
        "requirement",
        "threat",
        "zone",
      ]),
    });
    expect(JSON.stringify(generation)).not.toContain(first.key.headCommit);
    expect(JSON.stringify(generation)).not.toContain(first.key.contentHash);
  });

  it("rebuilds for dirty content and HEAD movement without writing YAML", async () => {
    const value = await fixture("movement");
    const first = await loadRepoContract(value.root, value.store, value.scope);
    const yamlPath = join(
      value.root,
      "product-security",
      "requirements",
      "REQ-OFFLINE.yaml",
    );
    const dirtyYaml = serializeRequirement(
      requirement("Dirty checkout requirement."),
    );
    await writeFile(yamlPath, dirtyYaml);

    const dirty = await loadRepoContract(value.root, value.store, value.scope);
    expect(dirty.rebuilt).toBe(true);
    expect(dirty.key.headCommit).toBe(first.key.headCommit);
    expect(dirty.key.contentHash).not.toBe(first.key.contentHash);
    expect(await readFile(yamlPath, "utf8")).toBe(dirtyYaml);

    await git(
      value.root,
      "add",
      "product-security/requirements/REQ-OFFLINE.yaml",
    );
    await git(value.root, "commit", "--quiet", "-m", "move checkout head");
    const moved = await loadRepoContract(value.root, value.store, value.scope);
    expect(moved.rebuilt).toBe(true);
    expect(moved.key.headCommit).not.toBe(dirty.key.headCommit);
    expect(moved.key.contentHash).toBe(dirty.key.contentHash);
  });

  it("recreates the same semantic projection when SQLite is deleted", async () => {
    const value = await fixture("golden", true);
    const first = await loadRepoContract(value.root, value.store, value.scope);
    const golden = normalizedProjection(value.store);
    value.store.db.close();
    await unlink(value.dbPath);

    const replacement = openFileStore(value.dbPath);
    const reloaded = await loadRepoContract(
      value.root,
      replacement,
      value.scope,
    );
    expect(reloaded).toEqual({ ...first, rebuilt: true });
    expect(normalizedProjection(replacement)).toEqual(golden);
    replacement.db.close();
  });

  it("maps multiple requirements to one compatible verification check", async () => {
    const value = await fixture("shared-check");
    await writeFile(
      join(
        value.root,
        "product-security",
        "requirements",
        "REQ-OFFLINE-TWO.yaml",
      ),
      serializeRequirement({
        ...requirement(),
        id: "REQ-OFFLINE-TWO",
        source_description: "A second requirement uses the shared check.",
      }),
    );
    const result = await loadRepoContract(value.root, value.store, value.scope);
    expect(result.diagnostics).toEqual([]);
    expect(
      value.store.db
        .prepare("SELECT COUNT(*) AS count FROM verification_checks")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      value.store.db
        .prepare("SELECT COUNT(*) AS count FROM requirement_check_mappings")
        .get(),
    ).toEqual({ count: 2 });
  });

  it("rejects accepted-cache shapes that are not valid authored TARA YAML", async () => {
    const value = await fixture("strict-tara-shape");
    const threats = join(value.root, "product-security", "threats");
    await mkdir(threats, { recursive: true });
    await writeFile(
      join(threats, "cache-shaped-threat.yaml"),
      "slug: cache-shaped-threat\ntitle: Missing authored fields\n",
    );

    const result = await loadRepoContract(value.root, value.store, value.scope);
    expect(result.entityCounts["requirement"]).toBe(1);
    expect(result.entityCounts["threat"]).toBe(0);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        path: "product-security/threats/cache-shaped-threat.yaml",
        message: expect.stringContaining("expected string"),
      }),
    ]);
  });

  it("prunes only a stale canonical-path sidecar and its exact synthetic scope", async () => {
    const first = await fixture("stale-first", true);
    const firstOnlyProject = "project-stale-first-only";
    const firstOnlyDirectory = join(
      first.root,
      ".fs",
      "triage",
      firstOnlyProject,
    );
    await mkdir(firstOnlyDirectory, { recursive: true });
    await writeFile(
      join(firstOnlyDirectory, "httpd-1.yaml"),
      (await readFile(REAL_TRIAGE_FIXTURE, "utf8")).replace(
        "project: project-ax3000-demo",
        `project: ${firstOnlyProject}`,
      ),
    );
    const secondRoot = await initializeRepository("stale-second", {
      fullCorpus: true,
    });
    const secondIdentity = await repoContractIdentity(secondRoot);
    const secondScope = contractLoadScope(secondIdentity.repositoryDigest);
    await loadRepoContract(first.root, first.store, first.scope);
    await loadRepoContract(secondRoot, first.store, secondScope);
    first.store.db
      .prepare(
        `INSERT INTO workspace_platform_project_binding
           (workspace_project_id, platform_project_id)
         VALUES ('workspace-stale', ?)`,
      )
      .run(first.scope.projectId);
    const sharedOverlayCount = first.store.db
      .prepare<
        [],
        { count: number }
      >("SELECT COUNT(*) AS count FROM overlay_index WHERE project_id = 'project-ax3000-demo'")
      .get();
    expect(sharedOverlayCount?.count).toBeGreaterThan(0);
    expect(
      first.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM overlay_index WHERE project_id = ?",
        )
        .get(firstOnlyProject),
    ).toEqual({ count: sharedOverlayCount?.count });

    const movedRoot = `${first.root}-moved`;
    await rename(first.root, movedRoot);
    temporaryRoots.splice(temporaryRoots.indexOf(first.root), 1, movedRoot);
    const unchanged = await loadRepoContract(
      secondRoot,
      first.store,
      secondScope,
    );
    expect(unchanged.rebuilt).toBe(false);
    expect(
      first.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_state WHERE project_id = ? AND project_version_id = ?",
        )
        .get(first.scope.projectId, first.scope.projectVersionId),
    ).toEqual({ count: 0 });
    expect(
      first.store.db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM workspace_platform_project_binding
            WHERE platform_project_id = ?`,
        )
        .get(first.scope.projectId),
    ).toEqual({ count: 0 });
    expect(
      first.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM sync_state WHERE project_id = ? AND project_version_id = ?",
        )
        .get(secondScope.projectId, secondScope.projectVersionId),
    ).toEqual({ count: 9 });
    expect(
      first.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM overlay_index WHERE project_id = 'project-ax3000-demo'",
        )
        .get(),
    ).toEqual(sharedOverlayCount);
    expect(
      first.store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM overlay_index WHERE project_id = ?",
        )
        .get(firstOnlyProject),
    ).toEqual({ count: 0 });
    const sidecars = (
      await readdir(first.dbPath.slice(0, first.dbPath.lastIndexOf("/")))
    ).filter((name) => name.startsWith("contract-load-"));
    expect(sidecars).toEqual([
      contractLoadSidecarName(secondIdentity.repositoryDigest),
    ]);
  });

  it("exposes a deterministic checkout-movement trigger with no timer sleeps", async () => {
    const root = await initializeRepository("monitor");
    const identity = await repoContractIdentity(root);
    const guardedFetch = vi.fn(() => {
      throw new Error("NETWORK_CALL_FORBIDDEN");
    });
    vi.stubGlobal("fetch", guardedFetch);
    const host = createFakePluginHost({
      pluginId: "finite-state-contract-load-monitor",
      sdk: {
        projects: {
          list: async () => [
            {
              id: "bb-project-monitor",
              kind: "standard" as const,
              name: "Monitor",
              gitRemoteUrl: null,
              createdAt: 1,
              updatedAt: 1,
              sources: [
                {
                  id: "source-monitor",
                  projectId: "bb-project-monitor",
                  isDefault: true,
                  createdAt: 1,
                  updatedAt: 1,
                  type: "local_path" as const,
                  hostId: "host-monitor",
                  path: root,
                },
              ],
            },
          ],
        },
      },
    });
    const monitor = registerRepoContractLoadService(
      host.bb,
      openStore(host.bb),
      host.bb.log,
    );
    expect(
      host.harness.registrations.services.map((service) => service.name),
    ).toContain("repo-contract-load");
    await expect(monitor.checkNow()).resolves.toEqual([
      expect.objectContaining({
        projectId: "bb-project-monitor",
        workspaceRoot: identity.canonicalRoot,
        result: expect.objectContaining({ rebuilt: true }),
      }),
    ]);
    await expect(monitor.checkNow()).resolves.toEqual([
      expect.objectContaining({
        result: expect.objectContaining({ rebuilt: false }),
      }),
    ]);

    const yamlPath = join(
      root,
      "product-security",
      "requirements",
      "REQ-OFFLINE.yaml",
    );
    await writeFile(
      yamlPath,
      serializeRequirement(requirement("Movement detected without sleeping.")),
    );
    await expect(monitor.checkNow()).resolves.toEqual([
      expect.objectContaining({
        result: expect.objectContaining({ rebuilt: true }),
      }),
    ]);
    expect(host.harness.sdk.callsTo("projects.list")).toHaveLength(3);
    expect(host.harness.sdk.callsTo("http.request")).toEqual([]);
    expect(guardedFetch).not.toHaveBeenCalled();
    const service = host.harness.runService("repo-contract-load");
    service.controller.abort();
    await expect(service.done).resolves.toBeUndefined();
    expect(host.harness.sdk.callsTo("projects.list")).toHaveLength(4);
    await host.harness.lifecycle.dispose();
  });

  it("keeps requirements on the real workspace while Bench and TARA use the synthetic projection", async () => {
    const root = await initializeRepository("registered-surfaces", {
      fullCorpus: true,
    });
    const workspaceProjectId = "bb-project-registered-surfaces";
    const guardedFetch = vi.fn(() => {
      throw new Error("NETWORK_CALL_FORBIDDEN");
    });
    vi.stubGlobal("fetch", guardedFetch);
    const host = createFakePluginHost({
      pluginId: "finite-state-contract-load-surfaces",
      sdk: {
        projects: {
          list: async () => [
            {
              id: workspaceProjectId,
              kind: "standard" as const,
              name: "Registered Surfaces",
              gitRemoteUrl: null,
              createdAt: 1,
              updatedAt: 1,
              sources: [
                {
                  id: "source-registered-surfaces",
                  projectId: workspaceProjectId,
                  isDefault: true,
                  createdAt: 1,
                  updatedAt: 1,
                  type: "local_path" as const,
                  hostId: "host-registered-surfaces",
                  path: root,
                },
              ],
            },
          ],
          get: async ({ projectId }) => {
            if (projectId !== workspaceProjectId) {
              throw new Error(
                `Unexpected synthetic project lookup: ${projectId}`,
              );
            }
            return {
              id: workspaceProjectId,
              kind: "standard" as const,
              name: "Registered Surfaces",
              gitRemoteUrl: null,
              createdAt: 1,
              updatedAt: 1,
              sources: [
                {
                  id: "source-registered-surfaces",
                  projectId: workspaceProjectId,
                  isDefault: true,
                  createdAt: 1,
                  updatedAt: 1,
                  type: "local_path" as const,
                  hostId: "host-registered-surfaces",
                  path: root,
                },
              ],
            };
          },
        },
        files: {
          list: async ({ path }) => ({
            files: path.endsWith("product-security/requirements")
              ? [{ name: "REQ-OFFLINE.yaml", path: "REQ-OFFLINE.yaml" }]
              : [],
            truncated: false,
          }),
          read: async ({ path }) => ({
            content: await readFile(path, "utf8"),
            contentEncoding: "utf8" as const,
            sha256: "a".repeat(64),
          }),
        },
      },
    });
    const context = createPluginContext(host.bb);
    registerProductSecurity(host.bb, context);
    registerBench(host.bb, context);
    const store = openStore(host.bb);
    const identity = await repoContractIdentity(root);
    const scope = contractLoadScope(identity.repositoryDigest);
    const monitor = registerRepoContractLoadService(
      host.bb,
      store,
      host.bb.log,
    );
    await expect(monitor.checkNow()).resolves.toEqual([
      expect.objectContaining({
        projectId: workspaceProjectId,
        result: expect.objectContaining({ rebuilt: true }),
      }),
    ]);
    expect(host.harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message: expect.stringContaining(
        "product-security/threats/malformed.yaml: line 2",
      ),
    });
    expect(host.harness.inspection.realtimeSignals).toEqual(
      expect.arrayContaining([
        {
          channel: "requirements:changed",
          payload: { projectId: workspaceProjectId },
        },
        {
          channel: "tara:changed",
          payload: {
            projectId: scope.projectId,
            projectVersionId: scope.projectVersionId,
          },
        },
      ]),
    );

    await expect(
      host.harness.behavior.callRpc("requirementsList", {
        projectId: workspaceProjectId,
        projectVersionId: null,
        pageSize: 50,
        continuation: null,
        filters: {},
      }),
    ).resolves.toMatchObject({
      items: [
        {
          projectId: workspaceProjectId,
          projectVersionId: null,
          key: "REQ-OFFLINE",
          fields: {
            requirement: { id: "REQ-OFFLINE" },
            local: true,
          },
        },
      ],
      total: 1,
    });
    await expect(
      host.harness.behavior.callRpc("benchProjectVersions", {
        projectId: workspaceProjectId,
      }),
    ).resolves.toEqual({
      versions: [
        {
          workspaceProjectId,
          platformProjectId: scope.projectId,
          projectVersionId: scope.projectVersionId,
          asOf: expect.any(String),
          state: "fresh",
        },
      ],
      selectedPlatformProjectId: scope.projectId,
      selectedProjectVersionId: scope.projectVersionId,
    });
    await expect(
      host.harness.behavior.callRpc("taraCanvasList", {
        workspaceProjectId,
        platformProjectId: scope.projectId,
        projectVersionId: scope.projectVersionId,
        kind: "threat",
        pageSize: 50,
        continuation: null,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          projectId: scope.projectId,
          projectVersionId: scope.projectVersionId,
          key: "threat-offline",
          label: "Offline threat",
        },
      ],
      total: 1,
      cache: { state: "fresh" },
    });
    expect(
      store.db
        .prepare(
          `SELECT requirement_key, total_checks
             FROM requirement_rollup
            WHERE project_id = ? AND project_version_id = ?`,
        )
        .all(scope.projectId, scope.projectVersionId),
    ).toEqual([
      {
        requirement_key: expect.stringMatching(/^fs1\./u),
        total_checks: 1,
      },
    ]);
    const projectLookups = JSON.stringify(
      host.harness.sdk.callsTo("projects.get"),
    );
    expect(projectLookups).toContain(workspaceProjectId);
    expect(projectLookups).not.toContain(scope.projectId);
    expect(host.harness.sdk.callsTo("http.request")).toEqual([]);
    expect(guardedFetch).not.toHaveBeenCalled();
    await host.harness.lifecycle.dispose();
  });

  it("rejects repo-local scope at every registered sync engine boundary", async () => {
    const value = await fixture("registered");
    const networkGuard = vi.fn(async () => {
      return Response.json(
        { error: { code: "OFFLINE_TEST_GUARD" } },
        { status: 401 },
      );
    });
    const host = createFakePluginHost({
      pluginId: "finite-state-contract-load-registered",
      sdk: {
        projects: {
          get: async () => ({
            id: "bb-project-offline",
            kind: "standard" as const,
            name: "Offline",
            gitRemoteUrl: null,
            createdAt: 1,
            updatedAt: 1,
            sources: [],
          }),
        },
      },
    });
    const context = createPluginContext(host.bb);
    const platform = new PlatformClient({
      baseUrl: "https://platform.invalid",
      token: "offline-test-token",
      fetch: networkGuard,
    });
    const assuranceStudio = new AssuranceStudioClient({
      baseUrl: "https://assurance-studio.invalid",
      apiKey: "offline-test-key",
      fetch: networkGuard,
    });
    const services: RemoteServices = {
      platform,
      assuranceStudio,
      forgeCompute: null,
    };
    context.service<RemoteServices>("remote-services", () => services);
    registerSync(host.bb, context);
    host.harness.sdk.stub("threads.get", async () =>
      makeThreadResponse({
        id: "thread-contract-load-cli",
        projectId: "bb-project-offline",
        environmentId: "environment-contract-load-cli",
      }),
    );
    host.harness.sdk.stub("environments.get", async () => ({
      id: "environment-contract-load-cli",
      projectId: "bb-project-offline",
      hostId: "host-contract-load-cli",
      path: value.root,
    }));
    const hostStore = openStore(host.bb);
    const identity = await repoContractIdentity(value.root);
    const scope = contractLoadScope(identity.repositoryDigest);
    await loadRepoContract(value.root, hostStore, scope);

    const repoLocalError =
      "REPO_LOCAL_SCOPE_NOT_SYNCABLE: This is a repo-local checkout projection, so there is nothing to sync; repository YAML is the source of truth.";
    await expect(
      host.harness.behavior.callRpc("syncPlan", {
        ...scope,
        kinds: ["vexDecision"],
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: repoLocalError,
    });
    expect(networkGuard).not.toHaveBeenCalled();

    await expect(
      host.harness.behavior.callRpc("syncPull", {
        ...scope,
        workspaceProjectId: "bb-project-offline",
        kinds: ["vexDecision"],
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: repoLocalError,
    });
    expect(networkGuard).not.toHaveBeenCalled();
    expect(
      hostStore.db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_platform_project_binding WHERE platform_project_id = ?",
        )
        .get(scope.projectId),
    ).toEqual({ count: 0 });

    await expect(
      host.harness.behavior.callRpc("syncStatus", {
        ...scope,
        kinds: ["vexDecision"],
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: repoLocalError,
    });
    expect(networkGuard).not.toHaveBeenCalled();

    const cliContext = {
      cwd: "/untrusted-contract-load-cwd",
      threadId: "thread-contract-load-cli",
      projectId: "bb-project-offline",
    };
    for (const verb of ["plan", "pull", "status"] as const) {
      await expect(
        host.harness.behavior.runCli(
          [
            "finite-state",
            verb,
            "triage",
            "--project",
            scope.projectId,
            "--version",
            scope.projectVersionId,
          ],
          cliContext,
        ),
      ).resolves.toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `bb finite-state failed: ${repoLocalError}`,
      });
      expect(networkGuard).not.toHaveBeenCalled();
    }

    const bindingCount = () =>
      hostStore.db
        .prepare(
          "SELECT COUNT(*) AS count FROM workspace_platform_project_binding WHERE platform_project_id = ?",
        )
        .get(scope.projectId);

    await expect(
      host.harness.behavior.callRpc("syncAsProjectCandidates", {
        workspaceProjectId: "bb-project-offline",
        projectId: scope.projectId,
        projectVersionId: null,
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: repoLocalError,
    });
    expect(networkGuard).not.toHaveBeenCalled();
    expect(bindingCount()).toEqual({ count: 0 });

    await expect(
      host.harness.behavior.callRpc("syncAsProjectSelect", {
        workspaceProjectId: "bb-project-offline",
        projectId: scope.projectId,
        projectVersionId: null,
        assuranceStudioProjectId: "as-project-should-not-bind",
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: repoLocalError,
    });
    expect(networkGuard).not.toHaveBeenCalled();
    expect(bindingCount()).toEqual({ count: 0 });

    const ordinaryScope = {
      projectId: "platform-project-ordinary",
      projectVersionId: "platform-version-ordinary",
    };
    await expect(
      host.harness.behavior.callRpc("syncPlan", {
        ...ordinaryScope,
        kinds: ["vexDecision"],
      }),
    ).resolves.toMatchObject({
      ...ordinaryScope,
      staleness: { degraded: true },
    });
    expect(networkGuard).toHaveBeenCalledTimes(1);

    networkGuard.mockClear();
    await expect(
      host.harness.behavior.callRpc("syncAsProjectCandidates", {
        workspaceProjectId: "bb-project-offline",
        projectId: ordinaryScope.projectId,
        projectVersionId: null,
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: expect.not.stringContaining("REPO_LOCAL_SCOPE_NOT_SYNCABLE"),
    });
    expect(networkGuard.mock.calls.length).toBeGreaterThan(0);

    // Delete-the-guard mutation control: both AS project RPC handlers must call
    // the shared scope assert before any Assurance Studio contact.
    const rpcSource = readFileSync(
      fileURLToPath(new URL("../../lanes/sync/rpc.ts", import.meta.url)),
      "utf8",
    );
    const candidatesHandler = rpcSource.match(
      /async syncAsProjectCandidates\(input\) \{([\s\S]*?)\n    \},/,
    )?.[1];
    const selectHandler = rpcSource.match(
      /async syncAsProjectSelect\(input\) \{([\s\S]*?)\n    \},/,
    )?.[1];
    expect(candidatesHandler).toMatch(
      /^\s*assertRemoteSyncScope\(input\.projectId\);/,
    );
    expect(selectHandler).toMatch(
      /^\s*assertRemoteSyncScope\(input\.projectId\);/,
    );
    expect(candidatesHandler).toMatch(
      /assertRemoteSyncScope\(input\.projectId\);[\s\S]*enumerateAssuranceStudioProjectCandidates/,
    );
    expect(selectHandler).toMatch(
      /assertRemoteSyncScope\(input\.projectId\);[\s\S]*selectAssuranceStudioProject/,
    );

    // Push is globally frozen today; this records that cover without pretending
    // it distinguishes scopes. Any unfreeze must use the guarded engine entries.
    await expect(
      host.harness.behavior.callRpc("syncPush", {
        ...scope,
        planId: "plan-offline",
        expectedPlanSha256: "a".repeat(64),
        expectedBaseStateSha256: "b".repeat(64),
        humanApprovalCapability: "offline-approval-capability-00000000",
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: expect.stringContaining("authorization-unavailable"),
    });
    expect(host.harness.sdk.callsTo("http.request")).toEqual([]);
    platform.close();
    assuranceStudio.close();
    await host.harness.lifecycle.dispose();
  });
});
