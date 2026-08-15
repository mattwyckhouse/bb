import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createPluginContext } from "../../../lib/context.js";
import { registerDocuments } from "../register.js";
import { DOCUMENTS_DIRECTORY, MAX_DOCUMENT_BYTES } from "../store.js";

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

async function setup(projectId = "project-a") {
  const root = await mkdtemp(join(tmpdir(), "fs-docs-up-"));
  temps.push(root);
  const host = createFakePluginHost({
    pluginId: `fs-docs-up-${crypto.randomUUID()}`,
  });
  hosts.push(host);
  host.harness.sdk.stub("projects.get", async ({ projectId: id }) => ({
    id,
    name: id,
    sources: [{ id: "src", path: root, isDefault: true }],
  }));
  registerDocuments(host.bb, createPluginContext(host.bb));
  return { host, root, projectId };
}

async function upload(
  host: ReturnType<typeof createFakePluginHost>,
  body: Record<string, unknown>,
) {
  return host.harness.behavior.fetchHttp("POST", "/documents/upload", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("documents upload envelope (AMD-0026 R2)", () => {
  it("accepts PDF/CSV via envelope and stores under product-security/documents", async () => {
    const { host, root, projectId } = await setup();
    const pdf = Buffer.from("%PDF-1.4 fixture bytes");
    const digest = sha256(pdf);
    const response = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: "version-a",
      filename: "datasheet.pdf",
      sha256: digest,
      metadata: { kind: "datasheet", mimeType: "application/pdf" },
      contentBase64: pdf.toString("base64"),
    });
    expect(response.status).toBe(201);
    const json = (await response.json()) as {
      created: boolean;
      document: { path: string; sha256: string };
    };
    expect(json.created).toBe(true);
    expect(json.document.sha256).toBe(digest);
    expect(json.document.path).toBe(
      `${DOCUMENTS_DIRECTORY}/${digest}-datasheet.pdf`,
    );
    const onDisk = await readFile(join(root, json.document.path));
    expect(sha256(onDisk)).toBe(digest);

    const csv = Buffer.from("mpn,qty\nABC,1\n");
    const csvDigest = sha256(csv);
    const csvResponse = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: "version-a",
      filename: "bom.csv",
      sha256: csvDigest,
      metadata: {},
      contentBase64: csv.toString("base64"),
    });
    expect(csvResponse.status).toBe(201);
  });

  it("rejects unknown envelopeVersion before decode and sha mismatch before ledger write", async () => {
    const { host, root, projectId } = await setup();
    const pdf = Buffer.from("%PDF-1.4 bytes");
    const badVersion = await upload(host, {
      envelopeVersion: 2,
      projectId,
      projectVersionId: null,
      filename: "x.pdf",
      sha256: sha256(pdf),
      metadata: {},
      contentBase64: pdf.toString("base64"),
    });
    expect(badVersion.status).toBe(400);
    expect(await badVersion.json()).toMatchObject({
      error: { code: "DOCUMENT_ENVELOPE_VERSION_UNSUPPORTED" },
    });
    await expect(
      readFile(join(root, DOCUMENTS_DIRECTORY, "x.pdf")),
    ).rejects.toThrow();

    const mismatch = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: null,
      filename: "x.pdf",
      sha256: "f".repeat(64),
      metadata: {},
      contentBase64: pdf.toString("base64"),
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      error: { code: "DOCUMENT_SHA256_MISMATCH" },
    });
    const listed = (await host.harness.behavior.callRpc("documentsList", {
      projectId,
      projectVersionId: null,
      pageSize: 50,
      continuation: null,
      filters: {},
    })) as { items: unknown[] };
    expect(listed.items).toEqual([]);
  });

  it("enforces decoded 50 MiB cap, MIME mismatch, unsafe names, sentinel, and scope isolation", async () => {
    const { host, projectId } = await setup();
    const oversized = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x41);
    // Prefix with PDF magic so type checks aren't the first failure.
    oversized[0] = 0x25;
    oversized[1] = 0x50;
    oversized[2] = 0x44;
    oversized[3] = 0x46;
    const over = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: "v1",
      filename: "big.pdf",
      sha256: sha256(oversized),
      metadata: {},
      contentBase64: oversized.toString("base64"),
    });
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({
      error: { code: "DOCUMENT_OVERSIZED" },
    });

    const pdf = Buffer.from("%PDF-1.4 ok");
    const mime = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: "v1",
      filename: "ok.pdf",
      sha256: sha256(pdf),
      metadata: { mimeType: "text/plain" },
      contentBase64: pdf.toString("base64"),
    });
    expect(mime.status).toBe(400);
    expect(await mime.json()).toMatchObject({
      error: { code: "DOCUMENT_MIME_MISMATCH" },
    });

    const traversal = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: "v1",
      filename: "../escape.pdf",
      sha256: sha256(pdf),
      metadata: {},
      contentBase64: pdf.toString("base64"),
    });
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toMatchObject({
      error: { code: "DOCUMENT_FILENAME_INVALID" },
    });

    const sentinel = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: "@project",
      filename: "ok.pdf",
      sha256: sha256(pdf),
      metadata: {},
      contentBase64: pdf.toString("base64"),
    });
    expect(sentinel.status).toBe(400);
    expect(await sentinel.json()).toMatchObject({
      error: { code: "DOCUMENT_SENTINEL_REJECTED" },
    });

    const first = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: "v1",
      filename: "ok.pdf",
      sha256: sha256(pdf),
      metadata: {},
      contentBase64: pdf.toString("base64"),
    });
    expect(first.status).toBe(201);
    const duplicate = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: "v1",
      filename: "ok.pdf",
      sha256: sha256(pdf),
      metadata: {},
      contentBase64: pdf.toString("base64"),
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).created).toBe(false);

    const otherVersion = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: "v2",
      filename: "ok.pdf",
      sha256: sha256(pdf),
      metadata: {},
      contentBase64: pdf.toString("base64"),
    });
    expect(otherVersion.status).toBe(201);

    const otherProjectHost = await setup("project-b");
    const foreign = await upload(otherProjectHost.host, {
      envelopeVersion: 1,
      projectId: "project-b",
      projectVersionId: "v1",
      filename: "ok.pdf",
      sha256: sha256(pdf),
      metadata: {},
      contentBase64: pdf.toString("base64"),
    });
    expect(foreign.status).toBe(201);
  });

  it("rejects invalid base64", async () => {
    const { host, projectId } = await setup();
    const response = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: null,
      filename: "ok.pdf",
      sha256: "a".repeat(64),
      metadata: {},
      contentBase64: "%%%not-base64%%%",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "DOCUMENT_BASE64_INVALID" },
    });
  });

  it("rolls back the ledger when promote destination cannot be written", async () => {
    const { host, root, projectId } = await setup();
    // Occupy product-security/documents as a file so mkdir/promote fails.
    await mkdir(join(root, "product-security"), { recursive: true });
    await writeFile(join(root, DOCUMENTS_DIRECTORY), "not-a-directory");
    const pdf = Buffer.from("%PDF-1.4 promote-fail");
    const response = await upload(host, {
      envelopeVersion: 1,
      projectId,
      projectVersionId: "v1",
      filename: "ok.pdf",
      sha256: sha256(pdf),
      metadata: {},
      contentBase64: pdf.toString("base64"),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const listed = (await host.harness.behavior.callRpc("documentsList", {
      projectId,
      projectVersionId: "v1",
      pageSize: 50,
      continuation: null,
      filters: {},
    })) as { items: unknown[] };
    expect(listed.items).toEqual([]);
  });
});
