import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createPluginContext } from "../../../lib/context.js";
import { registerDocuments } from "../register.js";
import { DOCUMENTS_DIRECTORY } from "../store.js";

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
  const root = await mkdtemp(join(tmpdir(), "fs-docs-ct-"));
  temps.push(root);
  const host = createFakePluginHost({
    pluginId: `fs-docs-ct-${crypto.randomUUID()}`,
  });
  hosts.push(host);
  host.harness.sdk.stub("projects.get", async () => ({
    id: "project-a",
    name: "Project A",
    sources: [{ id: "src", path: root, isDefault: true }],
  }));
  registerDocuments(host.bb, createPluginContext(host.bb));
  return { host, root };
}

describe("documents content route (AMD-0026 R2)", () => {
  it("serves scoped SHA via query parameter with safe headers and ranges", async () => {
    const { host, root } = await setup();
    const pdf = Buffer.from("%PDF-1.4 ranged-content-bytes");
    const digest = sha256(pdf);
    const upload = await host.harness.behavior.fetchHttp(
      "POST",
      "/documents/upload",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          envelopeVersion: 1,
          projectId: "project-a",
          projectVersionId: "version-a",
          filename: "spec.pdf",
          sha256: digest,
          metadata: {},
          contentBase64: pdf.toString("base64"),
        }),
      },
    );
    expect(upload.status).toBe(201);

    const full = await host.harness.behavior.fetchHttp(
      "GET",
      `/documents/content?sha256=${digest}&projectId=project-a&projectVersionId=version-a&path=${encodeURIComponent("/etc/passwd")}`,
    );
    expect(full.status).toBe(200);
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(full.headers.get("content-disposition")).toContain("spec.pdf");
    expect(Buffer.from(await full.arrayBuffer()).equals(pdf)).toBe(true);

    const ranged = await host.harness.behavior.fetchHttp(
      "GET",
      `/documents/content?sha256=${digest}&projectId=project-a&projectVersionId=version-a`,
      { headers: { range: "bytes=0-3" } },
    );
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer()).toString("utf8")).toBe(
      "%PDF",
    );

    const missingSha = await host.harness.behavior.fetchHttp(
      "GET",
      `/documents/content?projectId=project-a&projectVersionId=version-a`,
    );
    expect(missingSha.status).toBe(400);

    const foreign = await host.harness.behavior.fetchHttp(
      "GET",
      `/documents/content?sha256=${digest}&projectId=project-a&projectVersionId=other`,
    );
    expect(foreign.status).toBe(404);

    const projectLevel = await host.harness.behavior.fetchHttp(
      "GET",
      `/documents/content?sha256=${digest}&projectId=project-a&projectVersionId=`,
    );
    expect(projectLevel.status).toBe(404);

    await unlink(join(root, DOCUMENTS_DIRECTORY, `${digest}-spec.pdf`));
    const missingBlob = await host.harness.behavior.fetchHttp(
      "GET",
      `/documents/content?sha256=${digest}&projectId=project-a&projectVersionId=version-a`,
    );
    expect(missingBlob.status).toBe(404);
    expect(await missingBlob.json()).toMatchObject({
      error: { code: "DOCUMENT_CONTENT_MISSING" },
    });
    void mkdir;
    void writeFile;
  });

  it("rejects sentinel projectVersionId and malformed sha256", async () => {
    const { host } = await setup();
    const sentinel = await host.harness.behavior.fetchHttp(
      "GET",
      `/documents/content?sha256=${"a".repeat(64)}&projectId=project-a&projectVersionId=${encodeURIComponent("@project")}`,
    );
    expect(sentinel.status).toBe(400);
    expect(await sentinel.json()).toMatchObject({
      error: { code: "DOCUMENT_SENTINEL_REJECTED" },
    });

    const malformed = await host.harness.behavior.fetchHttp(
      "GET",
      `/documents/content?sha256=not-hex&projectId=project-a&projectVersionId=v1`,
    );
    expect(malformed.status).toBe(400);
  });
});
