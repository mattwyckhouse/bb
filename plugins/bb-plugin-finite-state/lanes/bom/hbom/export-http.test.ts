import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";

import { createPluginContext } from "../../../lib/context.js";
import { MIGRATIONS } from "../../../lib/store/schema.js";
import { registerBom } from "../register.js";
import * as xlsx from "./export/xlsx.js";
import { HBOM_SCHEMA_ID } from "./types.js";
import { HBOM_EMPTY_SHA256, writeHbomCas } from "./yaml.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    hosts.splice(0).map((host) => host.harness.lifecycle.dispose()),
  );
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function setupRegistered() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fs-hbom-export-http-")),
  );
  roots.push(root);
  const host = createFakePluginHost({
    pluginId: `hbom-http-${hosts.length}-${Date.now()}`,
  });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, MIGRATIONS);
  await mkdir(join(root, "product-security/hbom"), { recursive: true });
  await writeHbomCas(root, HBOM_EMPTY_SHA256, {
    schema: HBOM_SCHEMA_ID,
    project: "acme",
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
          at: "2026-08-02T00:00:00.000Z",
        },
      },
    ],
  });

  host.harness.sdk.stub("projects.get", async () => ({
    id: "project-a",
    name: "acme",
    sources: [{ id: "src", path: root, isDefault: true }],
  }));

  registerBom(host.bb, createPluginContext(host.bb));
  return { host, root, db };
}

describe("HBOM export HTTP", () => {
  it("registers local-auth routes and streams xlsx with safe headers", async () => {
    const { host } = await setupRegistered();
    expect(host.harness.registrations.httpRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          path: "/hbom/export.xlsx",
          auth: "local",
        }),
        expect.objectContaining({
          method: "GET",
          path: "/hbom/export.cdx.json",
          auth: "local",
        }),
      ]),
    );

    const response = await host.harness.behavior.fetchHttp(
      "GET",
      "/hbom/export.xlsx?project=project-a&mode=full",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "spreadsheetml.sheet",
    );
    expect(response.headers.get("content-disposition")).toMatch(
      /attachment; filename="[^"]+\.xlsx"/,
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(100);
  });

  it("never reflects malicious project names into Content-Disposition", async () => {
    const { host } = await setupRegistered();
    const malicious = encodeURIComponent('evil"\r\nX-Evil: injected');
    const response = await host.harness.behavior.fetchHttp(
      "GET",
      `/hbom/export.xlsx?project=${malicious}&mode=full`,
    );
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("X-Evil");
    expect(disposition).toMatch(
      /^attachment; filename="[A-Za-z0-9_.-]+\.xlsx"$/,
    );
    await response.arrayBuffer();
  });

  it("disables CycloneDX with CDX_HBOM_UNVERIFIED (no partial body)", async () => {
    const { host } = await setupRegistered();
    const response = await host.harness.behavior.fetchHttp(
      "GET",
      "/hbom/export.cdx.json?project=project-a&mode=full",
    );
    expect(response.status).toBe(501);
    const body = await response.json();
    expect(body).toEqual({
      error: expect.objectContaining({ code: "CDX_HBOM_UNVERIFIED" }),
    });
  });

  it("returns no partial download when workbook generation fails", async () => {
    const { host } = await setupRegistered();
    vi.spyOn(xlsx, "createHbomWorkbook").mockRejectedValueOnce(
      new xlsx.HbomExportError("HBOM_EXPORT_FAILED", "ExcelJS boom"),
    );
    const response = await host.harness.behavior.fetchHttp(
      "GET",
      "/hbom/export.xlsx?project=project-a&mode=full",
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.json()).toEqual({
      error: {
        code: "HBOM_EXPORT_FAILED",
        message: "ExcelJS boom",
      },
    });
  });
});
