import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createPluginContext } from "../../lib/context.js";
import { registerDocuments, type DocumentsServices } from "./register.js";
import {
  DocumentSourceRefError,
  decodeSourceRef,
  encodeSourceRef,
} from "./source-ref.js";

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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "fs-docs-src-"));
  temps.push(root);
  const host = createFakePluginHost({
    pluginId: `fs-docs-src-${crypto.randomUUID()}`,
  });
  hosts.push(host);
  host.harness.sdk.stub("projects.get", async () => ({
    id: "project-a",
    name: "Project A",
    sources: [{ id: "src", path: root, isDefault: true }],
  }));
  const ctx = createPluginContext(host.bb);
  registerDocuments(host.bb, ctx);
  return { host, root, ctx };
}

describe("document source-ref codec", () => {
  it("round-trips pdf page/bbox, quoted sheet names, and text lines", () => {
    const pdf = {
      documentSha256: "a".repeat(64),
      locator: {
        kind: "pdf" as const,
        page: 7,
        bbox: [0.1, 0.2, 0.8, 0.9] as [number, number, number, number],
      },
    };
    expect(decodeSourceRef(encodeSourceRef(pdf))).toEqual(pdf);

    const sheet = {
      documentSha256: "b".repeat(64),
      locator: {
        kind: "sheet" as const,
        sheet: "My Sheet's Data",
        cell: "A14",
      },
    };
    const encodedSheet = encodeSourceRef(sheet);
    expect(encodedSheet).toContain("'My Sheet''s Data'!A14");
    expect(decodeSourceRef(encodedSheet)).toEqual(sheet);

    const text = {
      documentSha256: "c".repeat(64),
      locator: { kind: "text" as const, lineStart: 3, lineEnd: 9 },
    };
    expect(decodeSourceRef(encodeSourceRef(text))).toEqual(text);
  });

  it("rejects zero page, inverted bbox, and unknown digest shapes", () => {
    expect(() =>
      encodeSourceRef({
        documentSha256: "d".repeat(64),
        locator: { kind: "pdf", page: 0 },
      }),
    ).toThrow(DocumentSourceRefError);

    expect(() =>
      decodeSourceRef(`docs/${"e".repeat(64)}#p1@0.8,0.2,0.1,0.9`),
    ).toThrow(/bbox/i);

    expect(() => decodeSourceRef("docs/not-a-digest#p1")).toThrow(
      DocumentSourceRefError,
    );
  });
});

describe("documents source-ref registration surface", () => {
  it("exports codec via documents.services", async () => {
    const { ctx } = await setup();
    const services = ctx.service<DocumentsServices>(
      "documents.services",
      () => {
        throw new Error("missing");
      },
    );
    const digest = createHash("sha256").update("x").digest("hex");
    const encoded = services.encodeSourceRef({
      documentSha256: digest,
      locator: { kind: "pdf", page: 1 },
    });
    expect(services.decodeSourceRef(encoded).locator).toEqual({
      kind: "pdf",
      page: 1,
    });
  });
});
