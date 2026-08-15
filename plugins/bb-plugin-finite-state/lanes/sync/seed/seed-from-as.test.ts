import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AGENT_SURFACE,
  AGENT_TOOL_NAMES,
} from "../../../lib/agentic/registry.js";
import {
  contractLoadScope,
  loadRepoContract,
} from "../../../lib/contract-load/loader.js";
import { repoContractIdentity } from "../../../lib/contract-load/projection-key.js";
import { createPluginContext } from "../../../lib/context.js";
import { createRemoteServiceController } from "../../../lib/remote/index.js";
import { AssuranceStudioClient } from "../../../lib/remote/assurance-studio/client.js";
import { PlatformClient } from "../../../lib/remote/platform/client.js";
import type { RemoteSettingValues } from "../../../lib/remote/config.js";
import {
  bindWorkspacePlatformProject,
  selectAssuranceStudioProjectBinding,
} from "../../../lib/store/project-scope.js";
import { openStore } from "../../../lib/store/index.js";
import { createSerializer } from "../serialize/serializer.js";
import { encodeKey } from "../../../lib/sync/registry.js";
import { createCanvasEntityAdapters } from "../../product-security/canvas/editing/adapters.js";
import { registerActionTools } from "../../agentic/tools/actions.js";
import { registerReadTools } from "../../agentic/tools/read.js";
import { registerWriteTools } from "../../agentic/tools/write.js";
import {
  CANONICAL_COMMANDS,
  renderPluginCommandsSkillFromMetadata,
} from "../../agentic/cli/metadata.js";
import {
  createMockRemote,
  type MockRemoteHarness,
} from "../../../test/mock-remote/server.js";
import { registerMockAssuranceStudio } from "../../../test/mock-remote/assurance-studio/register.js";
import { registerSyncCli } from "../cli.js";
import {
  registerAdapter,
  type EntityAdapter,
  type ServerEntity,
} from "../engine/adapter.js";
import { seedFromAs } from "./seed-from-as.js";

const execFileAsync = promisify(execFile);
const FIXTURE_ROOT = resolve(
  import.meta.dirname,
  "../../../test/mock-remote/fixtures",
);
const AS_PROJECT = "project-4a752600a07a";
const PLATFORM_PROJECT = "platform-seed-project";
const WORKSPACE_PROJECT = "bb-seed-project";
const FIXED_TIME = "2026-08-15T12:00:00.000Z";
const FIXED_RUN = "seed-run-100";

const resolver = {
  remoteToSlug: () => null,
  slugToRemote: () => null,
};

let remote: MockRemoteHarness;
let assuranceStudio: AssuranceStudioClient;
let productionAdapters: readonly EntityAdapter[];
const remoteRequests: Array<{ method: string; url: string }> = [];

beforeAll(() => {
  remote = createMockRemote({
    platformToken: "unused",
    assuranceStudioKey: "seed-key",
    fixtureRoot: FIXTURE_ROOT,
    register(service, registry) {
      if (service === "assurance-studio") {
        registerMockAssuranceStudio(registry, FIXTURE_ROOT);
      }
    },
  });
  assuranceStudio = new AssuranceStudioClient({
    baseUrl: "http://assurance-studio.mock",
    apiKey: "seed-key",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      remoteRequests.push({ method: request.method, url: request.url });
      return remote.assuranceStudio.fetch(input, init);
    },
  });
  productionAdapters = createCanvasEntityAdapters(assuranceStudio, resolver);
  for (const adapter of productionAdapters) registerAdapter(adapter);
});

afterAll(async () => {
  assuranceStudio.close();
  await remote.close();
});

function fakeAdapter(
  kind: "asset" | "component" | "dataflow" | "threat" | "zone",
  entities: readonly ServerEntity[] = [],
): EntityAdapter {
  return {
    kind,
    klass: "VERSIONED",
    serializer: createSerializer(kind),
    async *fetchRemote() {
      yield [...entities];
    },
    async readWorking() {
      return [];
    },
  };
}

function envelope(slug: string, humanEdited: boolean): ServerEntity {
  return {
    key: encodeKey("slug", slug),
    remoteId: `remote-${slug}`,
    payload: {
      id: `remote-${slug}`,
      projectId: AS_PROJECT,
      kind: "component",
      reviewVersion: "1",
      reviewStatus: "pending",
      humanEdited,
      fields: { slug, name: slug },
    },
  };
}

function boundedAdapters(
  entities: readonly ServerEntity[],
): readonly EntityAdapter[] {
  return [
    fakeAdapter("component", entities),
    fakeAdapter("zone"),
    fakeAdapter("asset"),
    fakeAdapter("dataflow"),
    fakeAdapter("threat"),
  ];
}

function emptySettings(): RemoteSettingValues {
  return {
    platformBaseUrl: "",
    platformToken: undefined,
    platformConcurrency: "8",
    asBaseUrl: "",
    asApiKey: undefined,
    asConcurrency: "8",
    forgeTransport: "disabled",
    forgeUrl: "",
    forgeCommand: "",
    forgeAuthToken: undefined,
    forgeConcurrency: "4",
    standaloneUnpackExecutablePath: "",
    standaloneUnpackImage: "localhost:5000/services-unpack:latest",
  };
}

async function runSeed(
  root: string,
  confirmOverwriteNonempty: boolean,
  adapters: readonly EntityAdapter[] = productionAdapters,
) {
  return seedFromAs({
    assuranceStudio,
    assuranceStudioProjectId: AS_PROJECT,
    worktreeRoot: root,
    confirmOverwriteNonempty,
    adapters,
    now: () => new Date(FIXED_TIME),
    createRunId: () => FIXED_RUN,
  });
}

describe("seed --from as", () => {
  it("writes the mock-AS adapter-backed tree through the registered CLI and contains blast radius", async () => {
    const root = await mkdtemp(join(tmpdir(), "fs-seed-cli-"));
    const cloneParent = await mkdtemp(join(tmpdir(), "fs-seed-clone-"));
    const cloneRoot = join(cloneParent, "checkout");
    const host = createFakePluginHost({ pluginId: "finite-state-seed-cli" });
    const context = createPluginContext(host.bb);
    const platform = new PlatformClient({
      baseUrl: "http://platform.mock/api",
      token: "unused",
      fetch: async () => {
        throw new Error("seed with --project must not call Platform");
      },
    });
    try {
      await execFileAsync("git", ["init", "--quiet"], { cwd: root });
      bindWorkspacePlatformProject(
        context.db(),
        WORKSPACE_PROJECT,
        PLATFORM_PROJECT,
      );
      selectAssuranceStudioProjectBinding(
        context.db(),
        WORKSPACE_PROJECT,
        PLATFORM_PROJECT,
        AS_PROJECT,
      );
      registerSyncCli(
        host.bb,
        { db: context.db(), worktreeRoot: null },
        platform,
        assuranceStudio,
        async () => ({
          worktreeRoot: root,
          workspaceProjectId: WORKSPACE_PROJECT,
        }),
      );
      const beforeRequests = remoteRequests.length;
      const result = await host.harness.behavior.runCli(
        [
          "finite-state",
          "seed",
          "--from",
          "as",
          "--project",
          PLATFORM_PROJECT,
          "--json",
        ],
        { threadId: "agent-shell-thread", projectId: WORKSPACE_PROJECT },
      );
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({
        outcome: "written",
        projectId: AS_PROJECT,
        skippedClasses: [
          expect.objectContaining({ kind: "requirement" }),
          expect.objectContaining({ kind: "mitigation" }),
          expect.objectContaining({ kind: "attackPath" }),
          expect.objectContaining({
            kind: "threat",
            reason: expect.stringContaining("FS-243"),
          }),
        ],
      });
      expect(report.filesWritten.length).toBeGreaterThan(0);
      expect(report.filesWritten).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            /^product-security\/architecture\/components\/.+\.yaml$/u,
          ),
          expect.stringMatching(
            /^product-security\/architecture\/dataflows\/.+\.yaml$/u,
          ),
        ]),
      );
      for (const file of report.filesWritten as string[]) {
        expect(
          file.startsWith(".fs/") || file.startsWith("product-security/"),
        ).toBe(true);
        expect(file.endsWith(".yaml")).toBe(true);
        const content = await readFile(join(root, file), "utf8");
        expect(content).toContain("# finite-state-seed/v1");
        expect(content).toContain(
          `# source_project: ${JSON.stringify(AS_PROJECT)}`,
        );
        expect(content).toMatch(
          /^# seeded_at: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/mu,
        );
        expect(content).toMatch(/^# run_id: "[0-9a-f-]{36}"$/mu);
      }

      const repeated = await host.harness.behavior.runCli(
        ["finite-state", "seed", "--from=as", "--project", PLATFORM_PROJECT],
        { threadId: "agent-shell-thread", projectId: WORKSPACE_PROJECT },
      );
      expect(repeated).toMatchObject({ exitCode: 3, stderr: "" });
      expect(repeated.stdout).toContain("Seed outcome: refused-nonempty");
      expect(repeated.stdout).toContain("Deferred classes:");
      expect(repeated.stdout).toContain("FS-241");
      expect(repeated.stdout).toContain("attackPath: deferred");
      expect(repeated.stdout).toContain("threat: deferred");
      expect(repeated.stdout).toContain("FS-243");

      const requests = remoteRequests.slice(beforeRequests);
      expect(requests.length).toBeGreaterThan(1);
      expect(new Set(requests.map((request) => request.method))).toEqual(
        new Set(["GET"]),
      );
      const status = await execFileAsync(
        "git",
        ["status", "--porcelain", "--untracked-files=all"],
        { cwd: root },
      );
      const changed = status.stdout.trim().split("\n").filter(Boolean);
      expect(changed.length).toBe(report.filesWritten.length);
      expect(
        changed.every((line) =>
          /^\?\? (?:\.fs|product-security)\/.+\.yaml$/u.test(line),
        ),
      ).toBe(true);
      await expect(
        execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root }),
      ).rejects.toThrow();
      const projectedRows = context
        .db()
        .prepare(
          "SELECT (SELECT COUNT(*) FROM base_snapshot) + (SELECT COUNT(*) FROM pull_generation) AS count",
        )
        .get() as { count: number };
      expect(projectedRows.count).toBe(0);

      await execFileAsync("git", ["config", "user.name", "Seed Reviewer"], {
        cwd: root,
      });
      await execFileAsync(
        "git",
        ["config", "user.email", "seed-reviewer@example.invalid"],
        { cwd: root },
      );
      await execFileAsync("git", ["add", "--all"], { cwd: root });
      await execFileAsync("git", ["commit", "--quiet", "-m", "seed baseline"], {
        cwd: root,
      });
      await execFileAsync("git", ["clone", "--quiet", root, cloneRoot]);

      const requestsBeforeFreshLoad = remoteRequests.length;
      const cloneIdentity = await repoContractIdentity(cloneRoot);
      const loaded = await loadRepoContract(
        cloneRoot,
        openStore(host.bb),
        contractLoadScope(cloneIdentity.repositoryDigest),
      );
      expect(loaded.diagnostics).toEqual([]);
      for (const kind of ["component", "zone", "asset", "dataflow"] as const) {
        expect(loaded.entityCounts[kind]).toBeGreaterThan(0);
      }
      expect(remoteRequests).toHaveLength(requestsBeforeFreshLoad);
    } finally {
      platform.close();
      await host.harness.lifecycle.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(cloneParent, { recursive: true, force: true });
    }
  });

  it("refuses non-empty roots without confirmation and preserves human-edited remote entities when confirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "fs-seed-overwrite-"));
    const humanFile = "product-security/architecture/components/human.yaml";
    const generatedFile =
      "product-security/architecture/components/generated.yaml";
    const adapters = boundedAdapters([
      envelope("human", true),
      envelope("generated", false),
    ]);
    try {
      await mkdir(join(root, "product-security/architecture/components"), {
        recursive: true,
      });
      await writeFile(join(root, humanFile), "manual: human\n", "utf8");
      await writeFile(join(root, generatedFile), "manual: stale\n", "utf8");

      const beforeFetches = remoteRequests.filter((request) =>
        request.url.includes("/components"),
      ).length;
      const refused = await runSeed(root, false, adapters);
      expect(refused).toMatchObject({
        outcome: "refused-nonempty",
        filesWritten: [],
      });
      expect(await readFile(join(root, humanFile), "utf8")).toBe(
        "manual: human\n",
      );
      expect(await readFile(join(root, generatedFile), "utf8")).toBe(
        "manual: stale\n",
      );
      expect(
        remoteRequests.filter((request) => request.url.includes("/components"))
          .length,
      ).toBe(beforeFetches);

      const written = await runSeed(root, true, adapters);
      expect(written).toMatchObject({
        outcome: "written",
        filesWritten: [generatedFile],
        skippedHumanEdited: [humanFile],
      });
      expect(await readFile(join(root, humanFile), "utf8")).toBe(
        "manual: human\n",
      );
      expect(await readFile(join(root, generatedFile), "utf8")).toContain(
        "name: generated",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns actionable AS-unconfigured guidance through the registered CLI without touching the worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "fs-seed-unconfigured-"));
    const host = createFakePluginHost({
      pluginId: "finite-state-seed-unconfigured",
    });
    const context = createPluginContext(host.bb);
    const controller = createRemoteServiceController(context, emptySettings());
    const platform = new PlatformClient({
      baseUrl: "http://platform.mock/api",
      token: "unused",
      fetch: async () => {
        throw new Error("seed with --project must not call Platform");
      },
    });
    try {
      bindWorkspacePlatformProject(
        context.db(),
        WORKSPACE_PROJECT,
        PLATFORM_PROJECT,
      );
      selectAssuranceStudioProjectBinding(
        context.db(),
        WORKSPACE_PROJECT,
        PLATFORM_PROJECT,
        AS_PROJECT,
      );
      registerSyncCli(
        host.bb,
        { db: context.db(), worktreeRoot: null },
        platform,
        controller.services.assuranceStudio,
        async () => ({
          worktreeRoot: root,
          workspaceProjectId: WORKSPACE_PROJECT,
        }),
      );
      const result = await host.harness.behavior.runCli(
        [
          "finite-state",
          "seed",
          "--from",
          "as",
          "--project",
          PLATFORM_PROJECT,
          "--json",
        ],
        { threadId: "agent-shell-thread", projectId: WORKSPACE_PROJECT },
      );
      expect(result).toMatchObject({ exitCode: 2, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "as-unconfigured",
        filesWritten: [],
        guidance: expect.stringContaining("asBaseUrl"),
      });
      expect(await readdirNames(root)).toEqual([]);
    } finally {
      platform.close();
      await controller.dispose();
      await host.harness.lifecycle.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is absent from the real native agent registration surface while remaining explicit CLI metadata", async () => {
    const host = createFakePluginHost({
      pluginId: "finite-state-seed-agent-guard",
    });
    const context = createPluginContext(host.bb);
    try {
      registerReadTools(host.bb, context);
      registerWriteTools(host.bb, context);
      registerActionTools(host.bb, context);
      const registered = host.harness.inspection.registrations.agentTools.map(
        (tool) => tool.name,
      );
      expect(registered).not.toEqual(
        expect.arrayContaining(["fs_seed_from_as"]),
      );
      expect(AGENT_TOOL_NAMES).not.toEqual(
        expect.arrayContaining(["fs_seed_from_as"]),
      );
      expect(Object.keys(AGENT_SURFACE.tools)).not.toEqual(
        expect.arrayContaining(["fs_seed_from_as"]),
      );
      expect(CANONICAL_COMMANDS.map((command) => command.name)).toEqual(
        expect.arrayContaining(["seed"]),
      );
      expect(renderPluginCommandsSkillFromMetadata()).toContain(
        "seed --from as",
      );
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});

async function readdirNames(path: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}
