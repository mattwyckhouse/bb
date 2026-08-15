/**
 * WP-101 stage-0 Code Assurance binding proof (FS-217).
 *
 * Consumption-path stand-in for fs-cli / SEI Code Assurance
 * ----------------------------------------------------------
 * Finite State `fs-cli` / SEI Code Assurance is not vendored in this
 * repository. The production binding inputs those tools need from a
 * requirements corpus are (1) a stable requirement key and (2) the EARS
 * statement text. This harness therefore:
 *
 *   1. loads the committed fixture checkout through WP-99 `loadRepoContract`
 *      with Assurance Studio and Platform unconfigured and `fetch` stubbed so
 *      any network call fails the proof;
 *   2. projects requirements through `exportRequirementBindings` (read-side
 *      adapter over the accepted SQLite projection — no second YAML parser);
 *   3. consumes the rows via `indexRequirementBindingsByStableKey`, the
 *      closest in-repo equivalent of the fs-cli/SEI lookup table that binds
 *      work to requirements by stable key rather than by file path.
 *
 * Owner ratification condition (2026-08-14): this stand-in is accepted for
 * the WP. Declaring stage 0 proven still requires one live `fs-cli`
 * invocation evidence capture against this fixture (not a CI dependency).
 * See fixture-repo/OWNER-LIVE-FS-CLI.md.
 */

import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  contractLoadScope,
  loadRepoContract,
} from "../../../lib/contract-load/loader.js";
import { repoContractIdentity } from "../../../lib/contract-load/projection-key.js";
import {
  exportRequirementBindings,
  indexRequirementBindingsByStableKey,
  type RequirementBindingRow,
} from "../../../lib/contract-load/requirements-export.js";
import { serializeRequirement } from "../../../lanes/product-security/requirements/cards/adapter.js";
import { renderEars } from "../../../lanes/product-security/requirements/cards/render-ears.js";
import type { RequirementYamlV1 } from "../../../lanes/product-security/requirements/cards/schema.js";
import { validateRequirementYaml } from "../../../lanes/product-security/requirements/cards/validator.js";
import { MIGRATIONS } from "../../../lib/store/schema.js";
import type { Store } from "../../../lib/store/index.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

const FIXTURE_REPO = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixture-repo",
);
const FIXTURE_REQUIREMENTS = join(
  FIXTURE_REPO,
  "product-security",
  "requirements",
);
const EXPECTED_BINDINGS_PATH = join(FIXTURE_REPO, "expected-bindings.json");

interface ExpectedBinding {
  readonly stableKey: string;
  readonly earsText: string;
  readonly status: string;
  readonly sourcePath: string;
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
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

async function materializeFixtureCheckout(tag: string): Promise<{
  root: string;
  store: Store;
  scope: ReturnType<typeof contractLoadScope>;
}> {
  const root = await mkdtemp(join(tmpdir(), `fs-stage0-${tag}-`));
  temporaryRoots.push(root);
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Stage0 Binding Test");
  await git(root, "config", "user.email", "stage0-binding@example.invalid");
  await cp(
    FIXTURE_REQUIREMENTS,
    join(root, "product-security", "requirements"),
    {
      recursive: true,
    },
  );
  // Keep an empty .fs tree so WP-99 hashes both contract roots consistently.
  await mkdir(join(root, ".fs"), { recursive: true });
  await writeFile(join(root, ".fs", ".gitkeep"), "");
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", "stage0 fixture");

  const databaseDirectory = await mkdtemp(
    join(tmpdir(), `fs-stage0-db-${tag}-`),
  );
  temporaryRoots.push(databaseDirectory);
  const store = openFileStore(join(databaseDirectory, "projection.db"));
  const identity = await repoContractIdentity(root);
  return {
    root,
    store,
    scope: contractLoadScope(identity.repositoryDigest),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readExpectedBindings(): Promise<readonly ExpectedBinding[]> {
  const raw = await readFile(EXPECTED_BINDINGS_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("expected-bindings.json must be an array");
  }
  return parsed.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry["stableKey"] !== "string" ||
      typeof entry["earsText"] !== "string" ||
      typeof entry["status"] !== "string" ||
      typeof entry["sourcePath"] !== "string"
    ) {
      throw new Error("expected-bindings.json entries are malformed");
    }
    return {
      stableKey: entry["stableKey"],
      earsText: entry["earsText"],
      status: entry["status"],
      sourcePath: entry["sourcePath"],
    };
  });
}

function bindingTable(
  rows: readonly RequirementBindingRow[],
): Record<string, RequirementBindingRow> {
  return Object.fromEntries(rows.map((row) => [row.stableKey, row]));
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("stage-0 Code Assurance binding against .fs/requirements", () => {
  it("binds every fixture requirement offline by stable key with EARS text intact", async () => {
    const expected = await readExpectedBindings();
    const checkout = await materializeFixtureCheckout("offline");
    const guardedFetch = vi.fn(() => {
      throw new Error("NETWORK_CALL_FORBIDDEN");
    });
    vi.stubGlobal("fetch", guardedFetch);

    const load = await loadRepoContract(
      checkout.root,
      checkout.store,
      checkout.scope,
    );
    expect(load.rebuilt).toBe(true);
    expect(load.entityCounts["requirement"]).toBe(expected.length);
    expect(load.diagnostics).toEqual([]);
    expect(guardedFetch).not.toHaveBeenCalled();

    const rows = exportRequirementBindings(checkout.store, checkout.scope);
    expect(rows).toHaveLength(expected.length);
    expect(bindingTable(rows)).toEqual(bindingTable(expected));

    const index = indexRequirementBindingsByStableKey(rows);
    for (const binding of expected) {
      const bound = index.get(binding.stableKey);
      expect(bound).toBeDefined();
      expect(bound?.earsText).toBe(binding.earsText);
      expect(bound?.status).toBe(binding.status);
    }
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("keeps the stable key across a requirements-root rename and updates EARS text in place", async () => {
    const checkout = await materializeFixtureCheckout("stability");
    const guardedFetch = vi.fn(() => {
      throw new Error("NETWORK_CALL_FORBIDDEN");
    });
    vi.stubGlobal("fetch", guardedFetch);

    await loadRepoContract(checkout.root, checkout.store, checkout.scope);
    const before = indexRequirementBindingsByStableKey(
      exportRequirementBindings(checkout.store, checkout.scope),
    );
    const target = before.get("REQ-FW-SIG");
    expect(target).toBeDefined();
    if (target === undefined) throw new Error("REQ-FW-SIG missing");

    // Rename across the two WP-99 requirement roots while keeping the stable
    // key (filename stays REQ-FW-SIG.yaml). Binding must follow the key, not
    // the path.
    await mkdir(join(checkout.root, ".fs", "requirements"), {
      recursive: true,
    });
    await rename(
      join(
        checkout.root,
        "product-security",
        "requirements",
        "REQ-FW-SIG.yaml",
      ),
      join(checkout.root, ".fs", "requirements", "REQ-FW-SIG.yaml"),
    );

    const afterRename = await loadRepoContract(
      checkout.root,
      checkout.store,
      checkout.scope,
    );
    expect(afterRename.rebuilt).toBe(true);
    const renamed = indexRequirementBindingsByStableKey(
      exportRequirementBindings(checkout.store, checkout.scope),
    ).get("REQ-FW-SIG");
    expect(renamed).toBeDefined();
    expect(renamed?.stableKey).toBe("REQ-FW-SIG");
    expect(renamed?.earsText).toBe(target.earsText);
    expect(renamed?.sourcePath).toBe(".fs/requirements/REQ-FW-SIG.yaml");

    const yamlPath = join(
      checkout.root,
      ".fs",
      "requirements",
      "REQ-FW-SIG.yaml",
    );
    const validated = validateRequirementYaml(
      await readFile(yamlPath, "utf8"),
      ".fs/requirements/REQ-FW-SIG.yaml",
    );
    expect(validated.success).toBe(true);
    if (!validated.success)
      throw new Error("fixture requirement became invalid");
    const editedEars = {
      pattern: "ubiquitous" as const,
      text: "",
      parts: {
        system: "gateway",
        response: "reject unsigned firmware and quarantine the image",
      },
    };
    const edited: RequirementYamlV1 = {
      ...validated.data,
      ears: {
        ...editedEars,
        text: renderEars(editedEars),
      },
    };
    await writeFile(yamlPath, serializeRequirement(edited));

    const afterEdit = await loadRepoContract(
      checkout.root,
      checkout.store,
      checkout.scope,
    );
    expect(afterEdit.rebuilt).toBe(true);
    const updated = indexRequirementBindingsByStableKey(
      exportRequirementBindings(checkout.store, checkout.scope),
    ).get("REQ-FW-SIG");
    expect(updated?.stableKey).toBe("REQ-FW-SIG");
    expect(updated?.earsText).toBe(
      "The gateway SHALL reject unsigned firmware and quarantine the image",
    );
    expect(updated?.earsText).not.toBe(target.earsText);
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("reports malformed and duplicate stable keys as named diagnostics without crashing", async () => {
    const checkout = await materializeFixtureCheckout("negative");
    const guardedFetch = vi.fn(() => {
      throw new Error("NETWORK_CALL_FORBIDDEN");
    });
    vi.stubGlobal("fetch", guardedFetch);

    await writeFile(
      join(
        checkout.root,
        "product-security",
        "requirements",
        "REQ-MALFORMED.yaml",
      ),
      "schema: fs-requirement/v1\nid: [unterminated\n",
    );
    // Same stable key under the alternate WP-99 requirements root — both paths
    // are canonical for their directories, so the loader must emit a duplicate
    // diagnostic naming the offending file rather than silently dropping rows.
    await mkdir(join(checkout.root, ".fs", "requirements"), {
      recursive: true,
    });
    await cp(
      join(
        checkout.root,
        "product-security",
        "requirements",
        "REQ-FW-SIG.yaml",
      ),
      join(checkout.root, ".fs", "requirements", "REQ-FW-SIG.yaml"),
    );

    const load = await loadRepoContract(
      checkout.root,
      checkout.store,
      checkout.scope,
    );
    expect(load.rebuilt).toBe(true);

    const malformed = load.diagnostics.find((diagnostic) =>
      diagnostic.path.endsWith("REQ-MALFORMED.yaml"),
    );
    expect(malformed).toBeDefined();
    expect(malformed?.message.length).toBeGreaterThan(0);

    const duplicate = load.diagnostics.find(
      (diagnostic) =>
        diagnostic.message.includes("already authored") &&
        (diagnostic.path === ".fs/requirements/REQ-FW-SIG.yaml" ||
          diagnostic.path === "product-security/requirements/REQ-FW-SIG.yaml"),
    );
    expect(duplicate).toBeDefined();

    const rows = exportRequirementBindings(checkout.store, checkout.scope);
    const index = indexRequirementBindingsByStableKey(rows);
    // Valid fixture rows survive; the duplicate does not silently replace them
    // and the malformed file does not appear as a bound row.
    expect(index.get("REQ-FW-SIG")).toBeDefined();
    expect(index.has("REQ-MALFORMED")).toBe(false);
    expect(rows.filter((row) => row.stableKey === "REQ-FW-SIG")).toHaveLength(
      1,
    );
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});
