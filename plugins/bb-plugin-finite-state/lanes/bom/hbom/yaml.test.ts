import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HBOM_RELATIVE_PATH,
  HBOM_SCHEMA_ID,
  type HbomDocument,
} from "./types.js";
import {
  HBOM_EMPTY_SHA256,
  HbomStaleError,
  readHbom,
  serializeHbom,
  writeHbomCas,
} from "./yaml.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "fs-hbom-yaml-")),
  );
  roots.push(directory);
  return directory;
}

function sample(project = "acme-router"): HbomDocument {
  return {
    schema: HBOM_SCHEMA_ID,
    project,
    options: { reviewThreshold: 0.9, exportThreshold: 0.9 },
    parts: [
      {
        id: "HBOM-0001",
        asComponentId: null,
        countryOfOrigin: { value: null },
        supplier: {
          value: "Avnet",
          provenance: "human",
          confidence: 1,
          by: "reviewer",
          at: "2026-07-30T09:14:00.000Z",
        },
      },
    ],
  };
}

describe("hbom yaml CAS", () => {
  it("emits deterministic bytes and round-trips", async () => {
    const projectRoot = await root();
    const first = serializeHbom(sample());
    const second = serializeHbom(sample());
    expect(first).toBe(second);
    expect(first).toContain("schema: fs-hbom/v1");
    expect(first).toContain("countryOfOrigin:");

    const sha = await writeHbomCas(projectRoot, HBOM_EMPTY_SHA256, sample());
    const read = await readHbom(projectRoot);
    expect(read.sha256).toBe(sha);
    expect(read.document.parts[0]?.supplier?.value).toBe("Avnet");
    expect(read.document.parts[0]?.countryOfOrigin).toEqual({ value: null });
    expect(serializeHbom(read.document)).toBe(first);
  });

  it("returns HBOM_STALE without changing the file on concurrent write", async () => {
    const projectRoot = await root();
    const sha = await writeHbomCas(projectRoot, HBOM_EMPTY_SHA256, sample());
    const before = await readFile(
      join(projectRoot, HBOM_RELATIVE_PATH),
      "utf8",
    );

    const next = sample("other-project");
    await expect(
      writeHbomCas(projectRoot, HBOM_EMPTY_SHA256, next),
    ).rejects.toBeInstanceOf(HbomStaleError);
    expect(await readFile(join(projectRoot, HBOM_RELATIVE_PATH), "utf8")).toBe(
      before,
    );

    const updated = await writeHbomCas(projectRoot, sha, next);
    expect(updated).not.toBe(sha);
    expect(createHash("sha256").update(before).digest("hex")).toBe(sha);
  });

  it("rejects last-writer-wins: stale expected SHA never overwrites", async () => {
    const projectRoot = await root();
    await writeHbomCas(projectRoot, HBOM_EMPTY_SHA256, sample());
    // Corrupt expected digest simulating a stale panel write.
    await expect(
      writeHbomCas(projectRoot, "d".repeat(64), sample("race")),
    ).rejects.toMatchObject({ code: "HBOM_STALE" });
  });
});
