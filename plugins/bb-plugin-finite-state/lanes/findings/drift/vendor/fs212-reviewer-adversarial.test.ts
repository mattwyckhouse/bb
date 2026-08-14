// FS-212 independent review — adversarial staging-retention probes.
// Not part of the PR; written by the reviewer to test the deletion boundary.
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginContext } from "../../../../lib/context.js";
import { findingStableKey } from "../../../../lib/sync/registry.js";
import { registerCachePuller } from "../../../sync/engine/adapter.js";
import { registerFindingsDrift, type FindingsDriftService } from "../index.js";
import {
  persistVendorDocument,
  pruneStaleVendorStaging,
  readVendorDocument,
  readVendorImport,
  VENDOR_STAGING_TTL_MS,
} from "./staging.js";

const PROJECT = "platform-adversarial";
const PV = "version-adversarial";
const GENERATION = "generation-adversarial";
const AT = "2026-08-13T13:00:00.000Z";
const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

function seedFinding(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
  component: { name: string; purl: string },
  cve: string,
  findingId: string,
): void {
  const key = findingStableKey(
    {
      cve,
      purl: component.purl,
      name: component.name,
      group: "acme",
      version: "1.0.0",
    },
    "purl",
  );
  db.prepare(
    `INSERT INTO findings
       (project_id, project_version_id, generation_id, finding_id, stable_key,
        cve, component_name, component_group, component_version, component_purl,
        raw, pulled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
  ).run(
    PROJECT,
    PV,
    GENERATION,
    findingId,
    key,
    cve,
    component.name,
    "acme",
    "1.0.0",
    component.purl,
    AT,
  );
}

function seedScope(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
): void {
  db.prepare(
    `INSERT INTO pull_generation
       (project_id, project_version_id, generation_id, status, requested_kinds_json,
        started_at, completed_at, accepted_at, error)
     VALUES (?, ?, ?, 'accepted', '["finding"]', ?, ?, ?, NULL)`,
  ).run(PROJECT, PV, GENERATION, AT, AT, AT);
  db.prepare(
    `INSERT INTO sync_state
       (project_id, project_version_id, entity_kind, accepted_generation_id,
        staging_generation_id, base_revision, staging_continuation, staged_pages,
        staged_rows, last_pull, error)
     VALUES (?, ?, 'finding', ?, NULL, 1, NULL, 0, 0, ?, NULL)`,
  ).run(PROJECT, PV, GENERATION, AT);
}

function vexDocument(
  statements: Array<{ ref: string; purl: string; name: string; cve: string }>,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      serialNumber: "urn:uuid:adversarial",
      components: statements.map((statement) => ({
        "bom-ref": statement.ref,
        purl: statement.purl,
        name: statement.name,
        version: "1.0.0",
      })),
      vulnerabilities: statements.map((statement) => ({
        id: statement.cve,
        affects: [{ ref: statement.ref }],
        analysis: {
          state: "not_affected",
          justification: "code_not_reachable",
          detail: "Supplier evidence",
        },
      })),
    }),
  );
}

async function driftService(root: string): Promise<{
  drift: FindingsDriftService;
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>;
}> {
  const host = createFakePluginHost({ pluginId: `adversarial-${root.length}` });
  hosts.push(host);
  const ctx = createPluginContext(host.bb);
  const db = ctx.db();
  seedScope(db);
  registerCachePuller("finding", async () => ({
    fetched: 0,
    baseRows: 0,
    quarantined: 0,
    advisories: [],
  }));
  registerFindingsDrift(ctx);
  return {
    db,
    drift: ctx.service<FindingsDriftService>("findings.drift", () => {
      throw new Error("Findings drift services are unavailable");
    }),
  };
}

describe("FS-212 adversarial: staging deletion boundary", () => {
  it("keeps staging when the apply writes nothing because every proposal write fails", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fs212-adv-zero-")),
    );
    roots.push(root);
    const { db, drift } = await driftService(root);
    seedFinding(
      db,
      { name: "staging", purl: "pkg:generic/acme/staging@1.0.0" },
      "CVE-ADV-ZERO",
      "finding-adv-zero",
    );

    const bytes = vexDocument([
      {
        ref: "staging-ref",
        purl: "pkg:generic/acme/staging@1.0.0",
        name: "staging",
        cve: "CVE-ADV-ZERO",
      },
    ]);
    const staged = drift.stageVendorDocument({
      projectId: PROJECT,
      pvId: PV,
      file: "adversarial.json",
      bytes,
    });
    const preview = await drift.previewVendorVex({
      root,
      projectId: PROJECT,
      pvId: PV,
      documentSha256: staged.documentSha256,
      vendor: "Acme",
    });

    // Make the overlay write path fail the way a real disk/permission/lock
    // failure does: the per-proposal error is collected, not thrown.
    await mkdir(join(root, ".fs", "triage"), { recursive: true });
    await writeFile(join(root, ".fs", "triage", PROJECT), "not a directory");

    const applied = await drift.applyVendorVex({
      root,
      projectId: PROJECT,
      pvId: PV,
      importId: preview.importId,
      expectedDocumentSha256: staged.documentSha256,
      overwrite: false,
    });

    // The apply wrote nothing and reported errors — it is not "spent".
    expect(applied.written).toBe(0);
    expect(applied.errors.length).toBeGreaterThan(0);

    // Staging must survive so the user can retry without re-uploading.
    expect(
      readVendorDocument(db, {
        projectId: PROJECT,
        pvId: PV,
        documentSha256: staged.documentSha256,
      }),
    ).not.toBeNull();
    expect(
      readVendorImport(db, {
        projectId: PROJECT,
        pvId: PV,
        importId: preview.importId,
      }),
    ).not.toBeNull();

    // And the retry must reach the apply path, not a "you never previewed" lie.
    await rm(join(root, ".fs", "triage", PROJECT), { force: true });
    const retried = await drift.applyVendorVex({
      root,
      projectId: PROJECT,
      pvId: PV,
      importId: preview.importId,
      expectedDocumentSha256: staged.documentSha256,
      overwrite: false,
    });
    expect(retried.written).toBe(1);
  });

  it("keeps staging when only part of a multi-statement apply is written", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "fs212-adv-part-")),
    );
    roots.push(root);
    const { db, drift } = await driftService(root);
    seedFinding(
      db,
      { name: "alpha", purl: "pkg:generic/acme/alpha@1.0.0" },
      "CVE-ADV-A",
      "finding-adv-a",
    );
    seedFinding(
      db,
      { name: "beta", purl: "pkg:generic/acme/beta@1.0.0" },
      "CVE-ADV-B",
      "finding-adv-b",
    );

    const bytes = vexDocument([
      {
        ref: "alpha-ref",
        purl: "pkg:generic/acme/alpha@1.0.0",
        name: "alpha",
        cve: "CVE-ADV-A",
      },
      {
        ref: "beta-ref",
        purl: "pkg:generic/acme/beta@1.0.0",
        name: "beta",
        cve: "CVE-ADV-B",
      },
    ]);
    const staged = drift.stageVendorDocument({
      projectId: PROJECT,
      pvId: PV,
      file: "adversarial-partial.json",
      bytes,
    });
    const preview = await drift.previewVendorVex({
      root,
      projectId: PROJECT,
      pvId: PV,
      documentSha256: staged.documentSha256,
      vendor: "Acme",
    });

    // A concurrent writer holds beta's overlay lock; alpha writes normally.
    await mkdir(join(root, ".fs", "triage", PROJECT), { recursive: true });
    await writeFile(join(root, ".fs", "triage", PROJECT, "beta.yaml.lock"), "");

    const applied = await drift.applyVendorVex({
      root,
      projectId: PROJECT,
      pvId: PV,
      importId: preview.importId,
      expectedDocumentSha256: staged.documentSha256,
      overwrite: false,
    });
    expect(applied.written).toBe(1);
    expect(applied.errors.length).toBeGreaterThan(0);

    // Half the document is unapplied; the staged bytes are still needed.
    expect(
      readVendorDocument(db, {
        projectId: PROJECT,
        pvId: PV,
        documentSha256: staged.documentSha256,
      }),
    ).not.toBeNull();
    expect(
      readVendorImport(db, {
        projectId: PROJECT,
        pvId: PV,
        importId: preview.importId,
      }),
    ).not.toBeNull();
  });

  it("sweeps only vendor_import rows and leaves other triage_runs history intact", () => {
    const host = createFakePluginHost({ pluginId: "fs212-adv-sweep" });
    hosts.push(host);
    const db = createPluginContext(host.bb).db();
    const now = new Date("2026-08-14T12:00:00.000Z");
    const ancient = new Date(
      now.getTime() - VENDOR_STAGING_TTL_MS - 60_000,
    ).toISOString();

    persistVendorDocument(db, {
      projectId: PROJECT,
      pvId: PV,
      file: "stale.json",
      bytes: Uint8Array.from([1]),
      documentSha256: "c".repeat(64),
    });
    db.prepare(`UPDATE triage_runs SET created_at = ? WHERE run_id = ?`).run(
      ancient,
      `vendor-document-${"c".repeat(64)}`,
    );

    for (const source of ["policy", "drift", "manual"] as const) {
      db.prepare(
        `INSERT INTO triage_runs
           (project_id, project_version_id, run_id, source, dry_run, status,
            input_digest, report_json, created_at, finished_at)
         VALUES (?, ?, ?, ?, 0, 'completed', NULL, '{}', ?, ?)`,
      ).run(PROJECT, PV, `run-${source}`, source, ancient, ancient);
    }

    expect(pruneStaleVendorStaging(db, now)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM triage_runs").pluck().get()).toBe(
      3,
    );
  });
});
