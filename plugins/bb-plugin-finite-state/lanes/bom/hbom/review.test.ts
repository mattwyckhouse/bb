import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createPluginContext } from "../../../lib/context.js";
import { MIGRATIONS } from "../../../lib/store/schema.js";
import { humanApprovalCapabilitySchema } from "../../../shared/contract.js";
import { registerBom } from "../register.js";
import {
  applyHumanReview,
  listHbomReview,
  resolveHbomReview,
  reviewCellId,
  type ReviewDeps,
} from "./review.js";
import { HBOM_SCHEMA_ID, type HbomDocument } from "./types.js";
import {
  HBOM_EMPTY_SHA256,
  HbomStaleError,
  readHbom,
  writeHbomCas,
} from "./yaml.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const DOC_A = "a".repeat(64);
const CAPABILITY = humanApprovalCapabilitySchema.parse(
  "offline-approval-capability-00000000",
);

function sampleDocument(): HbomDocument {
  return {
    schema: HBOM_SCHEMA_ID,
    project: "acme-router",
    options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
    parts: [
      {
        id: "HBOM-0001",
        asComponentId: "as-1",
        mpn: {
          value: "BCM6755KFEBG",
          provenance: "bom_import",
          sourceRef: {
            documentSha256: DOC_A,
            locator: { kind: "sheet", sheet: "Sheet1", cell: "A14" },
          },
          confidence: 0.72,
          by: "bb-agent",
          at: "2026-07-29T14:02:11.000Z",
          candidates: [
            {
              value: "BCM6755KFEB",
              provenance: "datasheet",
              sourceRef: {
                documentSha256: DOC_A,
                locator: { kind: "pdf", page: 7 },
              },
              confidence: 0.61,
              by: "bb-agent",
              at: "2026-07-29T14:02:11.000Z",
            },
          ],
        },
        supplier: {
          value: "Avnet",
          provenance: "human",
          confidence: 1,
          by: "seed-reviewer",
          at: "2026-07-30T09:14:00.000Z",
        },
        countryOfOrigin: { value: null },
      },
    ],
  };
}

async function setupModule() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fs-hbom-review-")));
  roots.push(root);
  const host = createFakePluginHost({
    pluginId: `hbom-review-${hosts.length}-${Date.now()}`,
  });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, MIGRATIONS);
  await mkdir(join(root, "product-security/hbom"), { recursive: true });
  await mkdir(join(root, "product-security/documents"), { recursive: true });
  db.prepare(
    `INSERT INTO document (
       project_id, project_version_id, document_id, sha256, name, path,
       doc_kind, mime_type, bytes, withdrawn, needs_ocr, uploaded_at,
       analyzed_by, analyzed_at, cells_extracted, indexed_at
     ) VALUES (?, '@project', ?, ?, 'bom.xlsx', ?, 'bom', 'text/csv', 12, 0, 0,
               '2026-07-29T00:00:00.000Z', NULL, NULL, 0, '2026-07-29T00:00:00.000Z')`,
  ).run(
    "project-a",
    "doc-1",
    DOC_A,
    `product-security/documents/${DOC_A}-bom.xlsx`,
  );
  const sha = await writeHbomCas(root, HBOM_EMPTY_SHA256, sampleDocument());
  const deps: ReviewDeps = { db, root };
  return { root, db, deps, sha, host };
}

describe("applyHumanReview", () => {
  it("stamps server-derived actor on accept and refuses client-forged identity", async () => {
    const { deps, sha, root } = await setupModule();
    const result = await applyHumanReview(
      deps,
      { id: "reviewer@example.com", at: "2026-08-14T12:00:00.000Z" },
      {
        projectId: "project-a",
        projectVersionId: null,
        expectedHbomSha256: sha,
        decisions: [{ action: "accept", partId: "HBOM-0001", field: "mpn" }],
      },
    );
    expect(result.applied).toBe(1);
    expect(result.rejected).toEqual([]);
    const read = await readHbom(root);
    expect(read.document.parts[0]?.mpn?.accepted).toEqual({
      by: "reviewer@example.com",
      at: "2026-08-14T12:00:00.000Z",
    });
    expect(read.document.parts[0]?.mpn?.by).toBe("bb-agent");
    expect(read.document.parts[0]?.mpn?.confidence).toBe(0.72);
  });

  it("accepts a candidate into the incumbent slot and keeps the prior claim", async () => {
    const { deps, sha, root } = await setupModule();
    await applyHumanReview(
      deps,
      { id: "reviewer@example.com", at: "2026-08-14T12:00:00.000Z" },
      {
        projectId: "project-a",
        projectVersionId: null,
        expectedHbomSha256: sha,
        decisions: [
          {
            action: "accept",
            partId: "HBOM-0001",
            field: "mpn",
            candidateIndex: 0,
          },
        ],
      },
    );
    const read = await readHbom(root);
    expect(read.document.parts[0]?.mpn?.value).toBe("BCM6755KFEB");
    expect(read.document.parts[0]?.mpn?.accepted?.by).toBe(
      "reviewer@example.com",
    );
    expect(
      read.document.parts[0]?.mpn?.candidates?.some(
        (candidate) => candidate.value === "BCM6755KFEBG",
      ),
    ).toBe(true);
  });

  it("rejects the incumbent back to unknown while preserving audit candidates", async () => {
    const { deps, sha, root } = await setupModule();
    await applyHumanReview(
      deps,
      { id: "reviewer@example.com", at: "2026-08-14T12:00:00.000Z" },
      {
        projectId: "project-a",
        projectVersionId: null,
        expectedHbomSha256: sha,
        decisions: [{ action: "reject", partId: "HBOM-0001", field: "mpn" }],
      },
    );
    const read = await readHbom(root);
    expect(read.document.parts[0]?.mpn?.value).toBeNull();
    expect(read.document.parts[0]?.mpn?.provenance).toBeUndefined();
    expect(read.document.parts[0]?.mpn?.candidates?.[0]?.value).toBe(
      "BCM6755KFEBG",
    );
  });

  it("edits to human provenance with confidence 1 and immutable prior trail", async () => {
    const { deps, sha, root } = await setupModule();
    const before = await readFile(
      join(root, "product-security/hbom/hbom.yaml"),
      "utf8",
    );
    await applyHumanReview(
      deps,
      { id: "reviewer@example.com", at: "2026-08-14T12:00:00.000Z" },
      {
        projectId: "project-a",
        projectVersionId: null,
        expectedHbomSha256: sha,
        decisions: [
          {
            action: "edit",
            partId: "HBOM-0001",
            field: "mpn",
            value: "HUMAN-MPN",
            note: "corrected from board photo",
          },
        ],
      },
    );
    const read = await readHbom(root);
    expect(read.document.parts[0]?.mpn).toMatchObject({
      value: "HUMAN-MPN",
      provenance: "human",
      confidence: 1,
      by: "reviewer@example.com",
      note: "corrected from board photo",
    });
    const after = await readFile(
      join(root, "product-security/hbom/hbom.yaml"),
      "utf8",
    );
    expect(after).not.toEqual(before);
  });

  it("returns HBOM_STALE without writing when expected SHA mismatches", async () => {
    const { deps, sha, root } = await setupModule();
    const before = await readFile(
      join(root, "product-security/hbom/hbom.yaml"),
      "utf8",
    );
    await expect(
      applyHumanReview(
        deps,
        { id: "reviewer@example.com", at: "2026-08-14T12:00:00.000Z" },
        {
          projectId: "project-a",
          projectVersionId: null,
          expectedHbomSha256: "d".repeat(64),
          decisions: [{ action: "accept", partId: "HBOM-0001", field: "mpn" }],
        },
      ),
    ).rejects.toBeInstanceOf(HbomStaleError);
    expect(
      await readFile(join(root, "product-security/hbom/hbom.yaml"), "utf8"),
    ).toBe(before);
    expect(sha).toHaveLength(64);
  });
});

describe("listHbomReview", () => {
  it("pages reviewable cells and summary/parts views", async () => {
    const { deps } = await setupModule();
    const queue = await listHbomReview(deps, {
      projectId: "project-a",
      projectVersionId: null,
      pageSize: 20,
      continuation: null,
      filters: {},
    });
    expect(queue.total).toBeGreaterThan(0);
    expect(queue.items[0]?.key).toBe(reviewCellId("HBOM-0001", "mpn"));
    expect(queue.items[0]?.fields.reason).toBe("conflict");

    const summary = await listHbomReview(deps, {
      projectId: "project-a",
      projectVersionId: null,
      pageSize: 5,
      continuation: null,
      filters: { view: "summary" },
    });
    expect(summary.items[0]?.fields.queueDepth).toBe(queue.total);
    expect(summary.items[0]?.fields.verifiedRatio).toBeTypeOf("number");

    const parts = await listHbomReview(deps, {
      projectId: "project-a",
      projectVersionId: null,
      pageSize: 20,
      continuation: null,
      filters: { view: "parts" },
    });
    expect(parts.items.some((item) => item.key === "HBOM-0001")).toBe(true);
  });
});

describe("resolveHbomReview registered surface", () => {
  it("fails closed with authorization-unavailable and never writes YAML", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "fs-hbom-rpc-")));
    roots.push(root);
    const host = createFakePluginHost({
      pluginId: `hbom-rpc-${Date.now()}`,
    });
    hosts.push(host);
    host.harness.sdk.stub("projects.get", async () => ({
      id: "project-a",
      name: "Project A",
      sources: [{ id: "src", path: root, isDefault: true }],
    }));
    registerBom(host.bb, createPluginContext(host.bb));
    await mkdir(join(root, "product-security/hbom"), { recursive: true });
    const sha = await writeHbomCas(root, HBOM_EMPTY_SHA256, sampleDocument());
    const before = await readFile(
      join(root, "product-security/hbom/hbom.yaml"),
      "utf8",
    );

    await expect(
      host.harness.behavior.callRpc("hbomReviewResolve", {
        projectId: "project-a",
        projectVersionId: null,
        humanApprovalCapability: CAPABILITY,
        expectedHbomSha256: sha,
        decisions: [{ id: reviewCellId("HBOM-0001", "mpn"), action: "accept" }],
      }),
    ).rejects.toThrow(/authorization-unavailable/u);

    expect(
      await readFile(join(root, "product-security/hbom/hbom.yaml"), "utf8"),
    ).toBe(before);

    // Module helper remains fail-closed even when called directly with a token.
    expect(() =>
      resolveHbomReview(
        { db: host.bb.storage.database(), root },
        {
          projectId: "project-a",
          projectVersionId: null,
          humanApprovalCapability: CAPABILITY,
          expectedHbomSha256: sha,
          decisions: [
            { id: reviewCellId("HBOM-0001", "mpn"), action: "accept" },
          ],
        },
      ),
    ).toThrow(/authorization-unavailable/u);
  });

  it("serves hbomReviewList through the registered RPC", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "fs-hbom-list-")));
    roots.push(root);
    const host = createFakePluginHost({
      pluginId: `hbom-list-${Date.now()}`,
    });
    hosts.push(host);
    host.harness.sdk.stub("projects.get", async () => ({
      id: "project-a",
      name: "Project A",
      sources: [{ id: "src", path: root, isDefault: true }],
    }));
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, MIGRATIONS);
    registerBom(host.bb, createPluginContext(host.bb));
    await mkdir(join(root, "product-security/hbom"), { recursive: true });
    db.prepare(
      `INSERT INTO document (
         project_id, project_version_id, document_id, sha256, name, path,
         doc_kind, mime_type, bytes, withdrawn, needs_ocr, uploaded_at,
         analyzed_by, analyzed_at, cells_extracted, indexed_at
       ) VALUES (?, '@project', ?, ?, 'bom.xlsx', ?, 'bom', 'text/csv', 12, 0, 0,
                 '2026-07-29T00:00:00.000Z', NULL, NULL, 0, '2026-07-29T00:00:00.000Z')`,
    ).run(
      "project-a",
      "doc-1",
      DOC_A,
      `product-security/documents/${DOC_A}-bom.xlsx`,
    );
    await writeHbomCas(root, HBOM_EMPTY_SHA256, sampleDocument());

    const page = await host.harness.behavior.callRpc("hbomReviewList", {
      projectId: "project-a",
      projectVersionId: null,
      pageSize: 20,
      continuation: null,
      filters: {},
    });
    if (
      typeof page !== "object" ||
      page === null ||
      !("items" in page) ||
      !Array.isArray(page.items)
    ) {
      throw new Error("hbomReviewList returned an unexpected page shape");
    }
    expect(page.items.length).toBeGreaterThan(0);
    const first = page.items[0];
    expect(
      typeof first === "object" &&
        first !== null &&
        "kind" in first &&
        first.kind,
    ).toBe("hbomReviewCell");
  });
});
