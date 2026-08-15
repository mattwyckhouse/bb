import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  extractPartTokens,
  filterHardwareComponents,
  seedHbomFromComponents,
  type HbomSeedComponent,
} from "./seed.js";
import { HBOM_EMPTY_SHA256, readHbom, writeHbomCas } from "./yaml.js";
import { HBOM_SCHEMA_ID } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "fs-hbom-seed-")),
  );
  roots.push(directory);
  return directory;
}

const COMPONENTS: HbomSeedComponent[] = [
  {
    id: "as-hw-1",
    componentType: "hardware",
    name: "Main SoC BCM6755",
    description: "Wi-Fi 6 SoC hosting BCM6755 silicon",
    technologies: ["linux"],
    criticality: "high",
    zoneId: "zone-1",
  },
  {
    id: "as-sw-1",
    componentType: "software",
    name: "Should be filtered",
  },
  {
    id: "as-sensor-1",
    componentType: "sensor",
    name: "Temp sensor",
    description: "board thermistor",
  },
];

describe("hbom seed", () => {
  it("filters to hardware types and leaves procurement empty", async () => {
    expect(filterHardwareComponents(COMPONENTS).map((c) => c.id)).toEqual([
      "as-hw-1",
      "as-sensor-1",
    ]);

    const projectRoot = await root();
    const result = await seedHbomFromComponents({
      root: projectRoot,
      project: "acme-router",
      asProjectId: "as-project-1",
      components: COMPONENTS,
      actor: "seed",
      at: "2026-07-28T10:00:00.000Z",
    });

    expect(result.created).toBe(2);
    expect(result.document.parts).toHaveLength(2);
    const soc = result.document.parts.find(
      (part) => part.asComponentId === "as-hw-1",
    );
    expect(soc?.description?.provenance).toBe("as_component");
    expect(soc?.category?.value).toBe("other");
    expect(soc?.mpn?.value).toBeNull();
    expect(soc?.supplier?.value).toBeNull();
    expect(soc?.lifecycleStatus?.value).toBeNull();
    expect(soc?.countryOfOrigin?.value).toBeNull();
    expect(soc?.mpn?.candidates?.some((c) => c.value === "BCM6755")).toBe(true);
  });

  it("is idempotent on repeat seed and marks AS-deleted parts", async () => {
    const projectRoot = await root();
    const first = await seedHbomFromComponents({
      root: projectRoot,
      project: "acme-router",
      components: COMPONENTS,
      at: "2026-07-28T10:00:00.000Z",
    });
    const second = await seedHbomFromComponents({
      root: projectRoot,
      project: "acme-router",
      components: COMPONENTS,
      expectedSha256: first.sha256,
      at: "2026-07-28T11:00:00.000Z",
    });
    expect(second.created).toBe(0);
    expect(second.markedMissing).toBe(0);

    const third = await seedHbomFromComponents({
      root: projectRoot,
      project: "acme-router",
      components: COMPONENTS.filter((c) => c.id !== "as-sensor-1"),
      expectedSha256: second.sha256,
      at: "2026-07-28T12:00:00.000Z",
    });
    expect(third.markedMissing).toBe(1);
    const missing = third.document.parts.find(
      (part) => part.asComponentId === "as-sensor-1",
    );
    expect(missing?.asMissing).toBe(true);
  });

  it("never overwrites a human MPN on re-seed", async () => {
    const projectRoot = await root();
    const seeded = await seedHbomFromComponents({
      root: projectRoot,
      project: "acme-router",
      components: [COMPONENTS[0]!],
      at: "2026-07-28T10:00:00.000Z",
    });
    const part = seeded.document.parts[0]!;
    part.mpn = {
      value: "HUMAN-MPN-1",
      provenance: "human",
      confidence: 1,
      by: "reviewer",
      at: "2026-07-30T09:14:00.000Z",
    };
    const sha = await writeHbomCas(projectRoot, seeded.sha256, seeded.document);

    const again = await seedHbomFromComponents({
      root: projectRoot,
      project: "acme-router",
      components: [
        {
          ...COMPONENTS[0]!,
          description: "Updated description mentioning BCM9999",
        },
      ],
      expectedSha256: sha,
      at: "2026-07-28T13:00:00.000Z",
    });
    const reseeded = again.document.parts[0]!;
    expect(reseeded.mpn?.value).toBe("HUMAN-MPN-1");
    expect(reseeded.mpn?.provenance).toBe("human");
    expect(reseeded.description?.value).toContain("Updated description");
  });

  it("extracts part-like tokens as candidates never MPN facts", () => {
    expect(extractPartTokens("SoC BCM6755KFEBG on board", "U1")).toContain(
      "BCM6755KFEBG",
    );
    expect(extractPartTokens("plain words only")).toEqual([]);
  });

  it("creates the YAML when missing using the empty SHA", async () => {
    const projectRoot = await root();
    const result = await seedHbomFromComponents({
      root: projectRoot,
      project: "acme-router",
      components: [],
      expectedSha256: HBOM_EMPTY_SHA256,
    });
    expect(result.document.schema).toBe(HBOM_SCHEMA_ID);
    const read = await readHbom(projectRoot);
    expect(read.document.parts).toEqual([]);
  });
});
