import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createPluginContext } from "../../lib/context.js";
import { registerDocuments } from "./register.js";
import {
  listDocuments,
  recordDocumentExtractions,
  searchDocuments,
} from "./search.js";
import { encodeSourceRef } from "./source-ref.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "fs-docs-search-"));
  temps.push(root);
  const host = createFakePluginHost({
    pluginId: `fs-docs-search-${crypto.randomUUID()}`,
  });
  hosts.push(host);
  host.harness.sdk.stub("projects.get", async () => ({
    id: "project-a",
    name: "Project A",
    sources: [{ id: "src", path: root, isDefault: true }],
  }));
  const ctx = createPluginContext(host.bb);
  registerDocuments(host.bb, ctx);
  return { host, db: ctx.db() };
}

describe("documents search and extraction recording", () => {
  it("pages search hits with bounded snippets and reverse targets", async () => {
    const { host, db } = await setup();
    const pdf = Buffer.from("%PDF-1.4 search-doc");
    const digest = sha256(pdf);
    const uploaded = await host.harness.behavior.fetchHttp(
      "POST",
      "/documents/upload",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          envelopeVersion: 1,
          projectId: "project-a",
          projectVersionId: "version-a",
          filename: "parts.pdf",
          sha256: digest,
          metadata: { kind: "datasheet" },
          contentBase64: pdf.toString("base64"),
        }),
      },
    );
    expect(uploaded.status).toBe(201);

    const recorded = recordDocumentExtractions(
      db,
      { projectId: "project-a", projectVersionId: "version-a" },
      digest,
      [
        {
          field: "mpn",
          value: "BCM6755",
          confidence: 0.91,
          sourceRef: {
            documentSha256: digest,
            locator: { kind: "pdf", page: 2, bbox: [0.1, 0.1, 0.4, 0.2] },
          },
          target: { surface: "hbom", id: "HBOM-0001", field: "mpn" },
        },
        {
          field: "rationale",
          value: "secure boot clause",
          confidence: 0.7,
          sourceRef: {
            documentSha256: digest,
            locator: { kind: "pdf", page: 4 },
          },
          target: {
            surface: "requirements",
            id: "REQ-104",
            field: "rationale",
          },
        },
      ],
    );
    expect(recorded.written).toBe(2);

    const page = (await host.harness.behavior.callRpc("documentsSearch", {
      projectId: "project-a",
      projectVersionId: "version-a",
      query: "BCM6755",
      pageSize: 1,
      continuation: null,
    })) as {
      items: Array<{
        documentSha256: string;
        field: string;
        value: string;
        snippet: string | null;
        sourceRef: Parameters<typeof encodeSourceRef>[0];
        target: { kind: string; key: string } | null;
      }>;
      next: string | null;
    };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      documentSha256: digest,
      field: "mpn",
      value: "BCM6755",
      target: {
        kind: "hbom",
        key: "HBOM-0001",
      },
    });
    expect(page.items[0]?.snippet?.includes("BCM6755")).toBe(true);
    expect(page.items.length).toBeGreaterThanOrEqual(1);

    const requirementHits = (await host.harness.behavior.callRpc(
      "documentsSearch",
      {
        projectId: "project-a",
        projectVersionId: "version-a",
        query: "secure boot",
        pageSize: 10,
        continuation: null,
      },
    )) as {
      items: Array<{ target: { kind: string; key: string } | null }>;
    };
    expect(requirementHits.items[0]?.target).toMatchObject({
      kind: "requirements",
      key: "REQ-104",
    });

    // Force a continuation by writing many matching rows, then page size 1.
    for (let index = 0; index < 3; index += 1) {
      recordDocumentExtractions(
        db,
        { projectId: "project-a", projectVersionId: "version-a" },
        digest,
        [
          {
            field: `alias-${index}`,
            value: `BCM6755-alias-${index}`,
            confidence: 0.5,
            sourceRef: {
              documentSha256: digest,
              locator: { kind: "pdf", page: index + 5 },
            },
          },
        ],
      );
    }
    const paged = (await host.harness.behavior.callRpc("documentsSearch", {
      projectId: "project-a",
      projectVersionId: "version-a",
      query: "BCM6755",
      pageSize: 1,
      continuation: null,
    })) as { items: unknown[]; next: string | null };
    expect(paged.next).toBeTypeOf("string");
    const second = (await host.harness.behavior.callRpc("documentsSearch", {
      projectId: "project-a",
      projectVersionId: "version-a",
      query: "BCM6755",
      pageSize: 1,
      continuation: paged.next,
    })) as { items: unknown[] };
    expect(second.items.length).toBeGreaterThanOrEqual(1);

    db.prepare(
      `INSERT INTO document_extraction (
         project_id, project_version_id, extraction_id, document_id, field, value,
         confidence, source_ref, locator_kind, status, extracted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "project-a",
      "version-a",
      "bad-row",
      digest,
      "broken",
      "x",
      0.5,
      "not-a-valid-ref",
      "pdf",
      "proposal",
      new Date().toISOString(),
    );

    const tolerant = searchDocuments(
      db,
      { projectId: "project-a", projectVersionId: "version-a" },
      { query: "broken", pageSize: 10, continuation: null },
    );
    expect(tolerant.items).toEqual([]);

    const listed = listDocuments(
      db,
      { projectId: "project-a", projectVersionId: "version-a" },
      { pageSize: 10, continuation: null, filters: { kind: "datasheet" } },
    );
    expect(listed.items).toHaveLength(1);
    expect(encodeSourceRef(page.items[0]!.sourceRef)).toContain(digest);
  });
});
