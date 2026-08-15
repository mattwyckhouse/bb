import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginContext } from "../../../lib/context.js";
import { registerMentions, MENTION_PROVIDERS } from "./register.js";
import {
  searchProvider,
  withDeadline,
  type MentionSearchHooks,
} from "./search.js";
import { resolveProvider } from "./resolve.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
});

function setup(tag: string) {
  const host = createFakePluginHost({
    pluginId: `finite-state-mentions-${tag}`,
  });
  hosts.push(host);
  const ctx = createPluginContext(host.bb);
  registerMentions(host.bb, ctx);
  return { ...host, ctx, db: ctx.db() };
}

function seedSync(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
  entityKind: string,
  at = "2026-08-14T12:00:00.000Z",
): void {
  db.prepare(
    `INSERT OR IGNORE INTO pull_generation
       (project_id, project_version_id, generation_id, status,
        requested_kinds_json, started_at, completed_at, accepted_at)
     VALUES ('project-1', 'pv-1', 'gen-1', 'accepted', ?, ?, ?, ?)`,
  ).run(JSON.stringify([entityKind]), at, at, at);
  db.prepare(
    `INSERT OR REPLACE INTO sync_state
       (project_id, project_version_id, entity_kind, accepted_generation_id,
        base_revision, last_pull)
     VALUES ('project-1', 'pv-1', ?, 'gen-1', 1, ?)`,
  ).run(entityKind, at);
}

function seedModel(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
): void {
  seedSync(db, "requirement");
  seedSync(db, "threat");
  seedSync(db, "component");
  const insert = db.prepare(
    `INSERT INTO base_snapshot
       (project_id, project_version_id, entity_kind, generation_id, entity_key,
        remote_id, payload, content_hash, pulled_at)
     VALUES ('project-1', 'pv-1', ?, 'gen-1', ?, NULL, ?, 'hash', ?)`,
  );
  const at = "2026-08-14T12:00:00.000Z";
  insert.run(
    "requirement",
    "REQ-104",
    JSON.stringify({
      id: "REQ-104",
      status: "draft",
      ears: { text: "The system shall authenticate management sessions." },
    }),
    at,
  );
  insert.run(
    "requirement",
    "REQ-200",
    JSON.stringify({ id: "REQ-200", status: "approved", name: "other" }),
    at,
  );
  insert.run(
    "threat",
    "THREAT-22",
    JSON.stringify({ id: "THREAT-22", name: "WAN spoofing", status: "open" }),
    at,
  );
  insert.run(
    "component",
    "COMP-httpd",
    JSON.stringify({ id: "COMP-httpd", name: "httpd service" }),
    at,
  );
}

function seedFindings(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
): void {
  seedSync(db, "finding");
  const at = "2026-08-14T12:00:00.000Z";
  db.prepare(
    `INSERT INTO findings
       (project_id, project_version_id, generation_id, finding_id, stable_key,
        cve, title, component_name, component_version, component_purl,
        severity, risk_score, reachability_verdict, vex_status, raw, pulled_at)
     VALUES ('project-1', 'pv-1', 'gen-1', 'f1',
             'project-1|pkg:generic/busybox@1.36.1|CVE-2023-42364',
             'CVE-2023-42364', 'Busybox overflow', 'busybox', '1.36.1',
             'pkg:generic/busybox@1.36.1', 'high', 90, 'reachable', 'IN_TRIAGE',
             '{}', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO findings
       (project_id, project_version_id, generation_id, finding_id, stable_key,
        cve, title, component_name, component_purl, severity, risk_score,
        raw, pulled_at)
     VALUES ('project-1', 'pv-1', 'gen-1', 'f2',
             'project-1|pkg:generic/openssl@3|CVE-2024-1',
             'CVE-2024-1', 'OpenSSL issue', 'openssl',
             'pkg:generic/openssl@3.0.0', 'medium', 40, '{}', ?)`,
  ).run(at);
}

function seedSbom(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
): void {
  seedSync(db, "sbomComponent");
  const at = "2026-08-14T12:00:00.000Z";
  db.prepare(
    `INSERT INTO sbom_components
       (project_id, project_version_id, generation_id, component_id, component_key,
        purl, name, component_group, version, license, supplier, source,
        file_locations, raw, pulled_at)
     VALUES ('project-1', 'pv-1', 'gen-1', 'c1', 'generic/busybox@1.36.1',
             'pkg:generic/busybox@1.36.1', 'busybox', 'generic', '1.36.1',
             'GPL-2.0', 'upstream', 'sca', '[]', '{}', ?)`,
  ).run(at);
  db.prepare(
    `INSERT INTO sbom_vuln_rollup
       (project_id, project_version_id, generation_id, component_key,
        critical, high, medium, low, kev_count, max_epss, reachability_verdict,
        computed_at)
     VALUES ('project-1', 'pv-1', 'gen-1', 'generic/busybox@1.36.1',
             0, 1, 0, 0, 0, 0.4, 'reachable', ?)`,
  ).run(at);
}

function seedHbom(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
): void {
  const at = "2026-08-14T12:00:00.000Z";
  db.prepare(
    `INSERT INTO hbom_cells
       (project_id, project_version_id, part_key, field, value, provenance,
        confidence, state, file_sha256, indexed_at)
     VALUES ('project-1', 'pv-1', 'HBOM-0001', 'mpn', ?, 'datasheet', 0.9,
             'proposal', 'abc', ?)`,
  ).run(JSON.stringify("BCM6755"), at);
  db.prepare(
    `INSERT INTO hbom_cells
       (project_id, project_version_id, part_key, field, value, provenance,
        confidence, state, file_sha256, indexed_at)
     VALUES ('project-1', 'pv-1', 'HBOM-0001', 'partNumber', ?, 'datasheet', 0.9,
             'proposal', 'abc', ?)`,
  ).run(JSON.stringify("BCM6755-B0"), at);
}

function seedDocs(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
): void {
  const at = "2026-08-14T12:00:00.000Z";
  const sha = "a".repeat(64);
  db.prepare(
    `INSERT INTO document
       (project_id, project_version_id, document_id, sha256, name, path,
        doc_kind, mime_type, bytes, withdrawn, needs_ocr, uploaded_at, indexed_at)
     VALUES ('project-1', '@project', 'doc-1', ?, ?,
             ?, 'datasheet', 'application/pdf', 100, 0, 0, ?, ?)`,
  ).run(
    sha,
    "bcm6755-datasheet.pdf",
    `product-security/documents/${sha}-bcm6755-datasheet.pdf`,
    at,
    at,
  );
}

function seedRuns(
  db: ReturnType<ReturnType<typeof createPluginContext>["db"]>,
): void {
  seedSync(db, "verificationRun");
  const at = "2026-08-14T12:00:00.000Z";
  const digest = "b".repeat(64);
  db.prepare(
    `INSERT INTO verification_runs
       (project_id, project_version_id, generation_id, run_id, tier, matrix_col,
        kind, status, firmware_digest, started_at, finished_at, synced_at, raw)
     VALUES ('project-1', 'pv-1', 'gen-1', 'bench-run-88', 'tier0', 'static',
             'bench', 'completed', ?, ?, ?, ?, '{}')`,
  ).run(digest, at, at, at);
}

describe("mention providers (unit)", () => {
  it("registers exactly four providers with the canonical @/#/~ mapping once", () => {
    const { harness } = setup("register");
    const providers = harness.registrations.mentionProviders;
    expect(providers.map((provider) => provider.id).sort()).toEqual([
      "fs-docs",
      "fs-intel",
      "fs-model",
      "fs-runs",
    ]);
    expect(MENTION_PROVIDERS).toHaveLength(4);
    expect(
      providers.find((provider) => provider.id === "fs-model")?.triggers,
    ).toEqual(["@"]);
    expect(
      providers.find((provider) => provider.id === "fs-docs")?.triggers,
    ).toEqual(["@"]);
    expect(
      providers.find((provider) => provider.id === "fs-intel")?.triggers,
    ).toEqual(["#"]);
    expect(
      providers.find((provider) => provider.id === "fs-runs")?.triggers,
    ).toEqual(["~"]);
    expect(
      providers.filter((provider) => provider.id === "fs-intel"),
    ).toHaveLength(1);
  });

  it("ranks exact/prefix/fuzzy matches for every provider", async () => {
    const { db, harness } = setup("rank");
    seedModel(db);
    seedFindings(db);
    seedSbom(db);
    seedHbom(db);
    seedDocs(db);
    seedRuns(db);

    const model = harness.registrations.mentionProviders.find(
      (provider) => provider.id === "fs-model",
    );
    const docs = harness.registrations.mentionProviders.find(
      (provider) => provider.id === "fs-docs",
    );
    const intel = harness.registrations.mentionProviders.find(
      (provider) => provider.id === "fs-intel",
    );
    const runs = harness.registrations.mentionProviders.find(
      (provider) => provider.id === "fs-runs",
    );
    if (!model || !docs || !intel || !runs)
      throw new Error("providers missing");

    const modelHits = await model.search({
      trigger: "@",
      query: "REQ-104",
      projectId: "project-1",
      threadId: null,
    });
    expect(modelHits[0]?.id).toBe("REQ-104");

    const prefix = await model.search({
      trigger: "@",
      query: "REQ-",
      projectId: "project-1",
      threadId: null,
    });
    expect(prefix.map((item) => item.id)).toEqual(
      expect.arrayContaining(["REQ-104", "REQ-200"]),
    );

    const fuzzy = await model.search({
      trigger: "@",
      query: "spoof",
      projectId: "project-1",
      threadId: null,
    });
    expect(fuzzy.some((item) => item.id === "THREAT-22")).toBe(true);

    const docHits = await docs.search({
      trigger: "@",
      query: "bcm6755",
      projectId: "project-1",
      threadId: null,
    });
    expect(docHits[0]?.id).toMatch(/^doc:/);

    const runHits = await runs.search({
      trigger: "~",
      query: "bench-run-88",
      projectId: "project-1",
      threadId: null,
    });
    expect(runHits.some((item) => item.id === "run:bench-run-88")).toBe(true);
  });

  it("routes CVE, purl/name, and MPN through one fs-intel provider without duplicates", async () => {
    const { db, harness } = setup("intel");
    seedFindings(db);
    seedSbom(db);
    seedHbom(db);
    const intel = harness.registrations.mentionProviders.find(
      (provider) => provider.id === "fs-intel",
    );
    if (!intel) throw new Error("fs-intel missing");

    const cve = await intel.search({
      trigger: "#",
      query: "CVE-2023-42364",
      projectId: "project-1",
      threadId: null,
    });
    expect(cve.some((item) => item.id === "cve:CVE-2023-42364")).toBe(true);

    const purl = await intel.search({
      trigger: "#",
      query: "pkg:generic/busybox@1.36.1",
      projectId: "project-1",
      threadId: null,
    });
    expect(purl.some((item) => item.id.startsWith("sbom:"))).toBe(true);

    const name = await intel.search({
      trigger: "#",
      query: "busybox",
      projectId: "project-1",
      threadId: null,
    });
    const componentIds = name
      .filter((item) => item.id.startsWith("sbom:"))
      .map((item) => item.id);
    expect(new Set(componentIds).size).toBe(componentIds.length);

    const mpn = await intel.search({
      trigger: "#",
      query: "BCM6755",
      projectId: "project-1",
      threadId: null,
    });
    expect(mpn.some((item) => item.id === "hbom:HBOM-0001")).toBe(true);
    expect(mpn.filter((item) => item.id === "hbom:HBOM-0001")).toHaveLength(1);
  });

  it("search deadline returns empty and records timeout", async () => {
    const logs: Array<{ level: string; message: string }> = [];
    const hooks: MentionSearchHooks = {
      deadlineMs: 20,
      searchers: {
        "fs-model": async (_db, _scope, _query, signal) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => resolve(), 200);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          });
          return [];
        },
      },
    };
    const raced = await withDeadline(async (signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 100);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      return "late";
    }, 10);
    expect(raced.ok).toBe(false);
    if (raced.ok) throw new Error("expected timeout");
    expect(raced.reason).toBe("timeout");

    const { db } = setup("timeout");
    seedModel(db);
    const items = await searchProvider(
      "fs-model",
      db,
      "project-1",
      "REQ",
      hooks,
      {
        debug: (message) => logs.push({ level: "debug", message }),
        warn: (message) => logs.push({ level: "warn", message }),
      },
    );
    expect(items).toEqual([]);
    expect(logs.some((entry) => entry.message.includes("deadline"))).toBe(true);
  });

  it("resolver exception is caught and converted to safe context", async () => {
    const { db } = setup("resolve-throw");
    const result = await resolveProvider(
      "fs-model",
      db,
      "project-1",
      "REQ-104",
      {
        resolvers: {
          "fs-model": () => {
            throw new Error("boom storage");
          },
        },
      },
    );
    expect(result.context).toContain("Mention resolution error");
    expect(result.context).toContain("REQ-104");
    expect(result.context).not.toContain("boom storage".repeat(2));
  });

  it("deleted item resolves as missing, never stale success", async () => {
    const { db, harness } = setup("missing");
    seedModel(db);
    const model = harness.registrations.mentionProviders.find(
      (provider) => provider.id === "fs-model",
    );
    if (!model) throw new Error("fs-model missing");

    const found = await model.search({
      trigger: "@",
      query: "REQ-104",
      projectId: "project-1",
      threadId: null,
    });
    expect(found[0]?.id).toBe("REQ-104");

    db.prepare(
      `DELETE FROM base_snapshot
        WHERE entity_key = 'REQ-104' AND entity_kind = 'requirement'`,
    ).run();

    const resolved = await model.resolve("REQ-104");
    expect(resolved.context).toContain("no longer present");
    expect(resolved.context).toContain("REQ-104");
    expect(resolved.context).not.toContain("authenticate management");
  });
});
