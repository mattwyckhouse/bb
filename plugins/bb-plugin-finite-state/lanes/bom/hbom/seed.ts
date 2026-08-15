import type { AsEntity, Json } from "../../../lib/remote/types.js";
import {
  HBOM_CATEGORIES,
  HBOM_HARDWARE_COMPONENT_TYPES,
  type HbomCandidate,
  type HbomCategory,
  type HbomCell,
  type HbomDocument,
  type HbomHardwareComponentType,
  type HbomPart,
  type HbomReadResult,
} from "./types.js";
import {
  emptyHbomDocument,
  HBOM_EMPTY_SHA256,
  HbomMissingError,
  readHbom,
  writeHbomCas,
} from "./yaml.js";

export { HBOM_EMPTY_SHA256 } from "./yaml.js";

const HARDWARE_TYPE_SET = new Set<string>(HBOM_HARDWARE_COMPONENT_TYPES);

/** Modest seed confidence — never auto-verifies. */
export const HBOM_SEED_CONFIDENCE = 0.6;

const PART_TOKEN = /\b[A-Z]{2,}[A-Z0-9]*[0-9][A-Z0-9.-]*\b/gu;

export interface HbomSeedComponent {
  id: string;
  componentType: string;
  name: string;
  description?: string | null;
  technologies?: string[];
  criticality?: string | null;
  zoneId?: string | null;
}

export interface HbomSeedInput {
  root: string;
  project: string;
  asProjectId?: string;
  components: readonly HbomSeedComponent[];
  actor?: string;
  at?: string;
  expectedSha256?: string;
}

export interface HbomSeedResult {
  document: HbomDocument;
  sha256: string;
  created: number;
  updated: number;
  markedMissing: number;
  unchanged: number;
}

function isHardwareType(value: string): value is HbomHardwareComponentType {
  return HARDWARE_TYPE_SET.has(value);
}

function jsonString(value: Json | undefined): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function jsonStringArray(value: Json | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out;
}

/** Map an AS entity into the seed input shape without trusting remote types. */
export function hbomSeedComponentFromAsEntity(
  entity: AsEntity,
): HbomSeedComponent | null {
  if (entity.kind !== "component") return null;
  const componentType =
    jsonString(entity.fields.component_type) ??
    jsonString(entity.fields.componentType);
  if (componentType === null) return null;
  const name =
    jsonString(entity.fields.name) ??
    jsonString(entity.fields.title) ??
    entity.id;
  return {
    id: entity.id,
    componentType,
    name,
    description: jsonString(entity.fields.description),
    technologies: jsonStringArray(entity.fields.technologies),
    criticality: jsonString(entity.fields.criticality),
    zoneId:
      jsonString(entity.fields.zone_id) ?? jsonString(entity.fields.zoneId),
  };
}

export function filterHardwareComponents(
  components: readonly HbomSeedComponent[],
): HbomSeedComponent[] {
  return components.filter((component) =>
    isHardwareType(component.componentType),
  );
}

function mapCategory(componentType: string): HbomCategory {
  if (componentType === "sensor") return "sensor";
  if (componentType === "hsm" || componentType === "tee") return "crypto";
  if (componentType === "ecu" || componentType === "actuator") return "module";
  if (componentType === "medical_device") return "other";
  for (const category of HBOM_CATEGORIES) {
    if (category === componentType) return category;
  }
  return "other";
}

function securityRelevance(component: HbomSeedComponent): string {
  const bits: string[] = [];
  if (component.criticality) bits.push(`criticality:${component.criticality}`);
  if (component.zoneId) bits.push(`zone:${component.zoneId}`);
  if (bits.length === 0) return component.componentType;
  return bits.join(" ");
}

/** Extract part-like prose tokens; never treat them as MPN facts. */
export function extractPartTokens(
  ...texts: Array<string | null | undefined>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    if (text === null || text === undefined || text.length < 1) continue;
    for (const match of text.matchAll(PART_TOKEN)) {
      const token = match[0]!;
      if (seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

function seedCell<T>(value: T, at: string, actor: string): HbomCell<T> {
  return {
    value,
    provenance: "as_component",
    confidence: HBOM_SEED_CONFIDENCE,
    by: actor,
    at,
  };
}

function ownedByAsComponent(cell: HbomCell<unknown> | undefined): boolean {
  return cell?.provenance === "as_component";
}

function nextPartId(parts: readonly HbomPart[]): string {
  let max = 0;
  for (const part of parts) {
    const match = /^HBOM-([0-9]+)$/u.exec(part.id);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `HBOM-${String(max + 1).padStart(4, "0")}`;
}

function mpnCandidates(
  tokens: string[],
  at: string,
  actor: string,
): HbomCandidate<string>[] {
  return tokens.map((token) => ({
    value: token,
    provenance: "inferred",
    confidence: 0.4,
    by: actor,
    at,
  }));
}

function buildSeedPart(
  component: HbomSeedComponent,
  id: string,
  at: string,
  actor: string,
): HbomPart {
  const tokens = extractPartTokens(
    component.name,
    component.description,
    ...(component.technologies ?? []),
  );
  const part: HbomPart = {
    id,
    asComponentId: component.id,
    description: seedCell(component.description ?? component.name, at, actor),
    category: seedCell(mapCategory(component.componentType), at, actor),
    securityRelevance: seedCell(securityRelevance(component), at, actor),
    // Procurement fields remain empty (unknown), never laundered from AS prose.
    mpn: { value: null },
    supplier: { value: null },
    lifecycleStatus: { value: null },
    countryOfOrigin: { value: null },
  };
  if (tokens.length > 0) {
    part.mpn = {
      value: null,
      candidates: mpnCandidates(tokens, at, actor),
    };
  }
  return part;
}

function seedCellSemanticFingerprint(cell: HbomCell<unknown>): string {
  return JSON.stringify({
    value: cell.value,
    provenance: cell.provenance ?? null,
    confidence: cell.confidence ?? null,
    by: cell.by ?? null,
    sourceRef: cell.sourceRef ?? null,
    note: cell.note ?? null,
    accepted: cell.accepted ?? null,
    candidates: (cell.candidates ?? []).map((candidate) => ({
      value: candidate.value,
      provenance: candidate.provenance,
      confidence: candidate.confidence,
      by: candidate.by,
      sourceRef: candidate.sourceRef ?? null,
    })),
  });
}

function replaceAsOwnedCellIfChanged<T>(
  current: HbomCell<T> | undefined,
  next: HbomCell<T>,
  assign: (cell: HbomCell<T>) => void,
): boolean {
  if (!ownedByAsComponent(current)) return false;
  if (
    current !== undefined &&
    seedCellSemanticFingerprint(current) === seedCellSemanticFingerprint(next)
  ) {
    return false;
  }
  assign(next);
  return true;
}

function refreshAsOwnedCells(
  part: HbomPart,
  component: HbomSeedComponent,
  at: string,
  actor: string,
): boolean {
  let changed = false;
  const nextDescription = component.description ?? component.name;
  if (
    replaceAsOwnedCellIfChanged(
      part.description,
      seedCell(nextDescription, at, actor),
      (cell) => {
        part.description = cell;
      },
    )
  ) {
    changed = true;
  }
  if (
    replaceAsOwnedCellIfChanged(
      part.category,
      seedCell(mapCategory(component.componentType), at, actor),
      (cell) => {
        part.category = cell;
      },
    )
  ) {
    changed = true;
  }
  if (
    replaceAsOwnedCellIfChanged(
      part.securityRelevance,
      seedCell(securityRelevance(component), at, actor),
      (cell) => {
        part.securityRelevance = cell;
      },
    )
  ) {
    changed = true;
  }

  // Never overwrite human/document MPN; only attach inferred candidates when
  // the MPN cell is still unknown / as_component-owned empty.
  const tokens = extractPartTokens(
    component.name,
    component.description,
    ...(component.technologies ?? []),
  );
  if (
    tokens.length > 0 &&
    (part.mpn === undefined ||
      (part.mpn.value === null &&
        (part.mpn.provenance === undefined ||
          part.mpn.provenance === "as_component")))
  ) {
    const existing = new Set(
      (part.mpn?.candidates ?? []).map((candidate) =>
        JSON.stringify(candidate.value),
      ),
    );
    const additions = mpnCandidates(tokens, at, actor).filter(
      (candidate) => !existing.has(JSON.stringify(candidate.value)),
    );
    if (additions.length > 0) {
      part.mpn = {
        value: null,
        ...(part.mpn?.provenance !== undefined
          ? {
              provenance: part.mpn.provenance,
              confidence: part.mpn.confidence,
              by: part.mpn.by,
              at: part.mpn.at,
            }
          : {}),
        candidates: [...(part.mpn?.candidates ?? []), ...additions],
      };
      changed = true;
    }
  }

  if (part.asMissing === true) {
    part.asMissing = false;
    changed = true;
  }
  return changed;
}

/**
 * Idempotent seed from hardware-typed AS components. Matches on asComponentId,
 * adds new components, marks missing seeds without deleting enriched parts, and
 * never touches cells no longer owned by as_component provenance.
 */
export async function seedHbomFromComponents(
  input: HbomSeedInput,
): Promise<HbomSeedResult> {
  const actor = input.actor ?? "seed";
  const at = input.at ?? new Date().toISOString();
  const hardware = filterHardwareComponents(input.components);

  let current: HbomReadResult | null = null;
  try {
    current = await readHbom(input.root);
  } catch (error) {
    if (!(error instanceof HbomMissingError)) throw error;
  }

  const document = current?.document ?? emptyHbomDocument(input.project);
  if (input.asProjectId !== undefined) {
    document.asProjectId = input.asProjectId;
  }
  document.project = input.project;

  const byAsId = new Map<string, HbomPart>();
  for (const part of document.parts) {
    if (part.asComponentId) byAsId.set(part.asComponentId, part);
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const seen = new Set<string>();

  for (const component of hardware) {
    seen.add(component.id);
    const existing = byAsId.get(component.id);
    if (existing === undefined) {
      const part = buildSeedPart(
        component,
        nextPartId(document.parts),
        at,
        actor,
      );
      document.parts.push(part);
      byAsId.set(component.id, part);
      created += 1;
      continue;
    }
    if (refreshAsOwnedCells(existing, component, at, actor)) {
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  let markedMissing = 0;
  for (const part of document.parts) {
    if (
      part.asComponentId &&
      !seen.has(part.asComponentId) &&
      part.asMissing !== true
    ) {
      part.asMissing = true;
      markedMissing += 1;
    }
  }

  const expected = input.expectedSha256 ?? current?.sha256 ?? HBOM_EMPTY_SHA256;
  const sha256 = await writeHbomCas(input.root, expected, document);
  return {
    document,
    sha256,
    created,
    updated,
    markedMissing,
    unchanged,
  };
}
