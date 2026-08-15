import { Readable } from "node:stream";

import { encodeSourceRef } from "../../../documents/source-ref.js";
import { deriveHbomCellState } from "../schema.js";
import {
  HBOM_PART_FIELDS,
  type HbomCell,
  type HbomDocument,
  type HbomPart,
  type HbomPartField,
} from "../types.js";
import { emptyHbomDocument, HbomMissingError, readHbom } from "../yaml.js";
import {
  HbomExportError,
  type ExportArtifact,
  type ExportDeps,
  type HbomExportMode,
} from "./xlsx.js";

/**
 * ECMA-424 / CycloneDX HBOM taxonomy mapping is not yet owner-verified.
 * Customer-facing routes must stay disabled until this flips after schema review.
 */
export const CDX_HBOM_TAXONOMY_VERIFIED = false;

/** Standard cdx:device property names preferred over proprietary duplicates. */
export const CDX_DEVICE_PROPERTIES = {
  partNumber: "cdx:device:partNumber",
  serialNumber: "cdx:device:serialNumber",
  modelNumber: "cdx:device:modelNumber",
} as const;

export const CDX_HBOM_UNVERIFIED = "CDX_HBOM_UNVERIFIED" as const;

interface CdxProperty {
  name: string;
  value: string;
}

interface CdxComponent {
  type: "device";
  "bom-ref": string;
  name: string;
  manufacturer?: { name: string };
  supplier?: { name: string };
  properties: CdxProperty[];
}

export interface CdxDocument {
  bomFormat: "CycloneDX";
  specVersion: "1.6";
  version: number;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string; version: string }>;
    component: {
      type: "device";
      name: string;
      "bom-ref": string;
    };
    properties: CdxProperty[];
  };
  components: CdxComponent[];
}

function cellForField(
  part: HbomPart,
  field: HbomPartField,
): HbomCell<unknown> | undefined {
  return part[field];
}

function isVerified(cell: HbomCell<unknown>): boolean {
  return cell.provenance === "human" || cell.accepted !== undefined;
}

function cellValueString(cell: HbomCell<unknown> | undefined): string | null {
  if (cell === undefined || cell.value === null) return null;
  if (Array.isArray(cell.value)) return cell.value.join(", ");
  if (
    typeof cell.value === "string" ||
    typeof cell.value === "number" ||
    typeof cell.value === "boolean"
  ) {
    return String(cell.value);
  }
  return JSON.stringify(cell.value);
}

function fsProperty(
  field: string,
  suffix: "provenance" | "source" | "confidence",
  value: string,
): CdxProperty {
  return { name: `fs:hbom:${field}:${suffix}`, value };
}

function pushFieldProperties(
  properties: CdxProperty[],
  field: HbomPartField,
  cell: HbomCell<unknown>,
  mode: HbomExportMode,
): void {
  if (mode === "verified-only" && !isVerified(cell)) return;
  const value = cellValueString(cell);
  if (value === null && cell.provenance === undefined) return;

  if (field === "partNumber" && value !== null) {
    properties.push({ name: CDX_DEVICE_PROPERTIES.partNumber, value });
  } else if (
    field !== "manufacturer" &&
    field !== "supplier" &&
    field !== "mpn" &&
    value !== null
  ) {
    properties.push({ name: `fs:hbom:${field}`, value });
  }

  if (cell.provenance !== undefined) {
    properties.push(fsProperty(field, "provenance", cell.provenance));
  }
  if (cell.sourceRef !== undefined) {
    properties.push(
      fsProperty(field, "source", encodeSourceRef(cell.sourceRef)),
    );
  }
  if (cell.confidence !== undefined) {
    properties.push(fsProperty(field, "confidence", String(cell.confidence)));
  }
}

function mapPart(part: HbomPart, mode: HbomExportMode): CdxComponent | null {
  const properties: CdxProperty[] = [];
  let visibleFields = 0;
  for (const field of HBOM_PART_FIELDS) {
    const cell = cellForField(part, field);
    if (cell === undefined) continue;
    if (mode === "verified-only" && !isVerified(cell)) continue;
    visibleFields += 1;
    pushFieldProperties(properties, field, cell, mode);
  }
  if (mode === "verified-only" && visibleFields === 0) return null;

  const mpn = cellValueString(part.mpn);
  const manufacturer = cellValueString(part.manufacturer);
  const supplier = cellValueString(part.supplier);
  const name = mpn ?? cellValueString(part.partNumber) ?? part.id;

  const component: CdxComponent = {
    type: "device",
    "bom-ref": part.id,
    name,
    properties,
  };
  if (manufacturer !== null) {
    component.manufacturer = { name: manufacturer };
  }
  if (supplier !== null) {
    component.supplier = { name: supplier };
  }
  if (mpn !== null) {
    properties.unshift({ name: "fs:hbom:mpn", value: mpn });
  }
  return component;
}

/**
 * Structural checks against a pinned CycloneDX document shape.
 * Full JSON-Schema validation awaits taxonomy review (§9.1).
 */
export function validateCycloneDxHbomDocument(document: unknown): string[] {
  const issues: string[] = [];
  if (typeof document !== "object" || document === null) {
    return ["root must be an object"];
  }
  const bomFormat = Reflect.get(document, "bomFormat");
  const specVersion = Reflect.get(document, "specVersion");
  const version = Reflect.get(document, "version");
  const components = Reflect.get(document, "components");
  const metadata = Reflect.get(document, "metadata");
  if (bomFormat !== "CycloneDX") issues.push("bomFormat must be CycloneDX");
  if (typeof specVersion !== "string") issues.push("specVersion is required");
  if (typeof version !== "number") issues.push("version must be a number");
  if (!Array.isArray(components)) {
    issues.push("components must be an array");
  } else {
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index];
      if (typeof component !== "object" || component === null) {
        issues.push(`components[${index}] must be an object`);
        continue;
      }
      if (Reflect.get(component, "type") !== "device") {
        issues.push(`components[${index}].type must be device`);
      }
      if (typeof Reflect.get(component, "name") !== "string") {
        issues.push(`components[${index}].name must be a string`);
      }
      const properties = Reflect.get(component, "properties");
      if (properties !== undefined && !Array.isArray(properties)) {
        issues.push(`components[${index}].properties must be an array`);
      }
    }
  }
  if (typeof metadata !== "object" || metadata === null) {
    issues.push("metadata must be an object");
  }
  return issues;
}

function buildCycloneDx(
  document: HbomDocument,
  mode: HbomExportMode,
  projectId: string,
): CdxDocument {
  const components: CdxComponent[] = [];
  let verified = 0;
  let pending = 0;
  for (const part of document.parts) {
    for (const field of HBOM_PART_FIELDS) {
      const cell = cellForField(part, field);
      if (cell === undefined) continue;
      if (isVerified(cell)) verified += 1;
      else if (deriveHbomCellState(cell) !== "unknown") pending += 1;
    }
    const mapped = mapPart(part, mode);
    if (mapped !== null) components.push(mapped);
  }
  const total = verified + pending;
  const verifiedRatio = total === 0 ? 0 : verified / total;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [
        {
          vendor: "Finite State",
          name: "bb-plugin-finite-state",
          version: "0.1.0",
        },
      ],
      component: {
        type: "device",
        name: document.project || projectId,
        "bom-ref": "hbom-root",
      },
      properties: [
        {
          name: "fs:hbom:verified_ratio",
          value: verifiedRatio.toFixed(4),
        },
        {
          name: "fs:hbom:review_pending",
          value: String(pending),
        },
        {
          name: "fs:hbom:export_mode",
          value: mode,
        },
        {
          name: "fs:hbom:compliance_claim",
          value: "none",
        },
      ],
    },
    components,
  };
}

async function loadDocument(deps: ExportDeps): Promise<HbomDocument> {
  // Export reads tolerate later-withdrawn citations.
  try {
    return (await readHbom(deps.root)).document;
  } catch (error) {
    if (error instanceof HbomMissingError) {
      return emptyHbomDocument(deps.projectId);
    }
    throw error;
  }
}

export interface CycloneDxExportOptions {
  /** Test-only override. Production routes leave taxonomy unverified. */
  taxonomyVerified?: boolean;
}

/**
 * Experimental CycloneDX HBOM export. Disabled with CDX_HBOM_UNVERIFIED until
 * official-schema + taxonomy mapping review passes.
 */
export async function createCycloneDxHbom(
  deps: ExportDeps,
  mode: HbomExportMode,
  options: CycloneDxExportOptions = {},
): Promise<ExportArtifact> {
  if (mode !== "full" && mode !== "verified-only") {
    throw new HbomExportError(
      "HBOM_EXPORT_MODE_INVALID",
      "mode must be full or verified-only",
    );
  }
  const verified = options.taxonomyVerified ?? CDX_HBOM_TAXONOMY_VERIFIED;
  if (!verified) {
    throw new HbomExportError(
      CDX_HBOM_UNVERIFIED,
      "CycloneDX HBOM export is disabled until official-schema and cdx:device taxonomy mapping are verified. No FCC/CRA/CycloneDX compliance claim is implied.",
    );
  }

  const document = await loadDocument(deps);
  const cdx = buildCycloneDx(document, mode, deps.projectId);
  const issues = validateCycloneDxHbomDocument(cdx);
  if (issues.length > 0) {
    throw new HbomExportError(
      CDX_HBOM_UNVERIFIED,
      `CycloneDX mapping failed schema checks: ${issues[0]}`,
    );
  }

  const bytes = Buffer.from(`${JSON.stringify(cdx, null, 2)}\n`, "utf8");
  const stream = Readable.from([bytes]);
  let disposed = false;
  const project = (deps.projectKey ?? deps.projectId)
    .replace(/[^\w.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return {
    filename: `${project.length > 0 ? project : "hbom"}-hbom.cdx.json`,
    contentType: "application/vnd.cyclonedx+json",
    bytes: bytes.byteLength,
    stream,
    async dispose() {
      if (disposed) return;
      disposed = true;
      stream.destroy();
    },
  };
}

/** Pure mapper for tests — does not gate on taxonomy verification. */
export function mapHbomToCycloneDx(
  document: HbomDocument,
  mode: HbomExportMode,
  projectId: string,
): CdxDocument {
  return buildCycloneDx(document, mode, projectId);
}
