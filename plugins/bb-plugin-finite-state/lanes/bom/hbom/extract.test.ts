import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";

import { createPluginContext } from "../../../lib/context.js";
import { MIGRATIONS } from "../../../lib/store/schema.js";
import { humanApprovalCapabilitySchema } from "../../../shared/contract.js";
import { registerBom } from "../register.js";
import {
  applyHbomExtraction,
  applyHbomExtractionRpc,
  HBOM_EXTRACTION_MAX_PROPOSALS,
  type ExtractionDeps,
  type HbomProposal,
} from "./extract.js";
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
const DOC_IMG = "c".repeat(64);
const CAPABILITY = humanApprovalCapabilitySchema.parse(
  "offline-approval-capability-00000000",
);

function insertDocument(
  db: {
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
    };
  },
  opts: {
    sha256: string;
    kind: string;
    needsOcr?: boolean;
    withdrawn?: boolean;
    name?: string;
  },
): void {
  db.prepare(
    `INSERT INTO document (
       project_id, project_version_id, document_id, sha256, name, path,
       doc_kind, mime_type, bytes, withdrawn, needs_ocr, uploaded_at,
       analyzed_by, analyzed_at, cells_extracted, indexed_at
     ) VALUES (?, '@project', ?, ?, ?, ?, ?, 'application/pdf', 12, ?, ?,
               '2026-07-29T00:00:00.000Z', NULL, NULL, 0, '2026-07-29T00:00:00.000Z')`,
  ).run(
    "project-a",
    `doc-${opts.sha256.slice(0, 8)}`,
    opts.sha256,
    opts.name ?? "datasheet.pdf",
    `product-security/documents/${opts.sha256}-datasheet.pdf`,
    opts.kind,
    opts.withdrawn ? 1 : 0,
    opts.needsOcr ? 1 : 0,
  );
}

async function setup(seed?: HbomDocument) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fs-hbom-extract-")),
  );
  roots.push(root);
  const host = createFakePluginHost({
    pluginId: `hbom-extract-${hosts.length}-${Date.now()}`,
  });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, MIGRATIONS);
  await mkdir(join(root, "product-security/hbom"), { recursive: true });
  await mkdir(join(root, "product-security/documents"), { recursive: true });
  insertDocument(db, { sha256: DOC_A, kind: "datasheet" });
  insertDocument(db, {
    sha256: DOC_IMG,
    kind: "datasheet",
    needsOcr: true,
    name: "scan.pdf",
  });
  const document =
    seed ??
    ({
      schema: HBOM_SCHEMA_ID,
      project: "acme-router",
      options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
      parts: [
        {
          id: "HBOM-0001",
          asComponentId: null,
          supplier: {
            value: "Avnet",
            provenance: "human",
            confidence: 1,
            by: "reviewer",
            at: "2026-07-30T09:14:00.000Z",
          },
        },
      ],
    } satisfies HbomDocument);
  const sha = await writeHbomCas(root, HBOM_EMPTY_SHA256, document);
  const deps: ExtractionDeps = {
    db,
    root,
    projectId: "project-a",
    projectVersionId: null,
  };
  return { root, db, deps, sha, host };
}

function proposal(
  overrides: Partial<HbomProposal> & Pick<HbomProposal, "field" | "value">,
): HbomProposal {
  return {
    part: { id: "HBOM-0001" },
    sourceRef: {
      documentSha256: DOC_A,
      locator: { kind: "pdf", page: 7 },
    },
    confidence: 0.95,
    ...overrides,
  };
}

describe("applyHbomExtraction", () => {
  it("rejects batches over the 500 cap", async () => {
    const { deps, sha } = await setup();
    const proposals = Array.from(
      { length: HBOM_EXTRACTION_MAX_PROPOSALS + 1 },
      (_, index) =>
        proposal({
          field: "mpn",
          value: `PART-${index}`,
          sourceRef: {
            documentSha256: DOC_A,
            locator: { kind: "pdf", page: (index % 50) + 1 },
          },
        }),
    );
    await expect(
      applyHbomExtraction(
        deps,
        { id: "agent-1" },
        {
          documentSha256: DOC_A,
          expectedHbomSha256: sha,
          proposals,
          createMissingParts: false,
        },
      ),
    ).rejects.toMatchObject({ code: "HBOM_EXTRACTION_BATCH_TOO_LARGE" });
  });

  it("partially rejects invalid source refs and CAS-writes valid items", async () => {
    const { deps, sha, root } = await setup();
    const result = await applyHbomExtraction(
      deps,
      { id: "agent-1", at: "2026-08-15T12:00:00.000Z" },
      {
        documentSha256: DOC_A,
        expectedHbomSha256: sha,
        proposals: [
          proposal({ field: "mpn", value: "BCM6755" }),
          proposal({
            field: "manufacturer",
            value: "Broadcom",
            sourceRef: {
              documentSha256: DOC_A,
              locator: { kind: "text", lineStart: 1, lineEnd: 2 },
            },
          }),
          proposal({
            field: "description",
            value: "SoC",
            sourceRef: {
              documentSha256: "d".repeat(64),
              locator: { kind: "pdf", page: 1 },
            },
          }),
        ],
        createMissingParts: false,
      },
    );
    expect(result.merged).toBe(1);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected.map((item) => item.code).sort()).toEqual([
      "HBOM_SOURCE_REF_DOCUMENT_MISMATCH",
      "HBOM_SOURCE_REF_TEXT_FORBIDDEN",
    ]);
    const read = await readHbom(root);
    expect(read.document.parts[0]?.mpn?.value).toBe("BCM6755");
    expect(read.document.parts[0]?.mpn?.by).toBe("agent-1");
    expect(read.document.parts[0]?.mpn?.at).toBe("2026-08-15T12:00:00.000Z");
    expect(read.document.parts[0]?.mpn?.provenance).toBe("datasheet");
    expect(read.document.parts[0]?.mpn?.accepted).toBeUndefined();
  });

  it("rejects image-only documents without OCR coordinates", async () => {
    const { deps, sha } = await setup();
    const result = await applyHbomExtraction(
      deps,
      { id: "agent-1" },
      {
        documentSha256: DOC_IMG,
        expectedHbomSha256: sha,
        proposals: [
          proposal({
            field: "mpn",
            value: "HALLUCINATED",
            sourceRef: {
              documentSha256: DOC_IMG,
              locator: { kind: "pdf", page: 1 },
            },
          }),
        ],
        createMissingParts: false,
      },
    );
    expect(result.rejected).toEqual([
      expect.objectContaining({ code: "HBOM_SOURCE_IMAGE_ONLY" }),
    ]);
    expect(result.merged).toBe(0);
  });

  it("stamps actor identity and refuses human provenance/acceptance on proposals", async () => {
    const { deps, sha, root } = await setup();
    await applyHbomExtraction(
      deps,
      { id: "extractor-bot", at: "2026-08-15T01:00:00.000Z" },
      {
        documentSha256: DOC_A,
        expectedHbomSha256: sha,
        proposals: [proposal({ field: "mpn", value: "X" })],
        createMissingParts: false,
      },
    );
    const cell = (await readHbom(root)).document.parts[0]?.mpn;
    expect(cell?.by).toBe("extractor-bot");
    expect(cell?.provenance).not.toBe("human");
    expect(cell?.accepted).toBeUndefined();
  });

  it("createMissingParts false rejects unknown parts; true allocates HBOM ids", async () => {
    const { deps, sha } = await setup();
    const denied = await applyHbomExtraction(
      deps,
      { id: "agent-1" },
      {
        documentSha256: DOC_A,
        expectedHbomSha256: sha,
        proposals: [
          proposal({
            part: { mpn: "NEW-MPN" },
            field: "manufacturer",
            value: "Acme",
          }),
        ],
        createMissingParts: false,
      },
    );
    expect(denied.rejected[0]?.code).toBe("HBOM_PART_NOT_FOUND");

    const created = await applyHbomExtraction(
      deps,
      { id: "agent-1" },
      {
        documentSha256: DOC_A,
        expectedHbomSha256: sha,
        proposals: [
          proposal({
            part: { mpn: "NEW-MPN" },
            field: "manufacturer",
            value: "Acme",
          }),
        ],
        createMissingParts: true,
      },
    );
    expect(created.merged).toBe(1);
    expect(created.rejected).toHaveLength(0);
  });

  it("fails stale CAS without writing", async () => {
    const { deps } = await setup();
    await expect(
      applyHbomExtraction(
        deps,
        { id: "agent-1" },
        {
          documentSha256: DOC_A,
          expectedHbomSha256: "f".repeat(64),
          proposals: [proposal({ field: "mpn", value: "X" })],
          createMissingParts: false,
        },
      ),
    ).rejects.toBeInstanceOf(HbomStaleError);
  });

  it("fail-closed RPC never mutates YAML", async () => {
    const { deps, sha, root } = await setup();
    expect(() =>
      applyHbomExtractionRpc(deps, {
        projectId: "project-a",
        projectVersionId: null,
        humanApprovalCapability: CAPABILITY,
        documentSha256: DOC_A,
        expectedHbomSha256: sha,
        proposals: [
          {
            partKey: "HBOM-0001",
            field: "mpn",
            value: "SHOULD-NOT-LAND",
            sourceRef: {
              documentSha256: DOC_A,
              locator: { kind: "pdf", page: 1 },
            },
            confidence: 0.9,
          },
        ],
        createMissingParts: false,
      }),
    ).toThrow(/authorization-unavailable/i);
    const read = await readHbom(root);
    expect(read.document.parts[0]?.mpn).toBeUndefined();
  });

  it("registered hbomExtractionApply fails closed without CAS writes", async () => {
    const { root, sha, host } = await setup();
    host.harness.sdk.stub("projects.get", async () => ({
      id: "project-a",
      name: "Project A",
      sources: [{ id: "src", path: root, isDefault: true }],
    }));
    registerBom(host.bb, createPluginContext(host.bb));
    await expect(
      host.harness.behavior.callRpc("hbomExtractionApply", {
        projectId: "project-a",
        projectVersionId: null,
        humanApprovalCapability: CAPABILITY,
        documentSha256: DOC_A,
        expectedHbomSha256: sha,
        proposals: [
          {
            partKey: "HBOM-0001",
            field: "mpn",
            value: "SHOULD-NOT-LAND",
            sourceRef: {
              documentSha256: DOC_A,
              locator: { kind: "pdf", page: 1 },
            },
            confidence: 0.9,
          },
        ],
        createMissingParts: false,
      }),
    ).rejects.toThrow(/authorization-unavailable/i);
    expect((await readHbom(root)).document.parts[0]?.mpn).toBeUndefined();
  });
});
