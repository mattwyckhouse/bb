import type { DocumentSourceRef } from "../../../shared/contract.js";

/** Known provenance vocabulary. New values (kicad_bom, svd, …) remain valid strings. */
export const HBOM_KNOWN_PROVENANCE = [
  "as_component",
  "datasheet",
  "bom_import",
  "schematic",
  "inferred",
  "vendor",
  "human",
] as const;

export type HbomKnownProvenance = (typeof HBOM_KNOWN_PROVENANCE)[number];

/** Extensible provenance string; known values are listed in HBOM_KNOWN_PROVENANCE. */
export type HbomProvenance = HbomKnownProvenance | (string & {});

/** Provenances that require a document source_ref with page/region or sheet/cell. */
export const HBOM_SOURCE_REF_REQUIRED = new Set<string>([
  "datasheet",
  "bom_import",
  "schematic",
  "vendor",
]);

export const HBOM_SCHEMA_ID = "fs-hbom/v1" as const;

export const HBOM_RELATIVE_PATH = "product-security/hbom/hbom.yaml" as const;

export const HBOM_WATCH_GLOB = "product-security/hbom" as const;

export const HBOM_CHANGED_CHANNEL = "hbom:changed" as const;

export const HBOM_HARDWARE_COMPONENT_TYPES = [
  "hardware",
  "sensor",
  "actuator",
  "ecu",
  "hsm",
  "tee",
  "medical_device",
] as const;

export type HbomHardwareComponentType =
  (typeof HBOM_HARDWARE_COMPONENT_TYPES)[number];

export const HBOM_CATEGORIES = [
  "soc",
  "mcu",
  "memory",
  "pmic",
  "sensor",
  "phy",
  "crypto",
  "connector",
  "passive",
  "module",
  "other",
] as const;

export type HbomCategory = (typeof HBOM_CATEGORIES)[number];

export const HBOM_LIFECYCLE_STATUSES = [
  "active",
  "nrnd",
  "eol",
  "obsolete",
  "unknown",
] as const;

export type HbomLifecycleStatus = (typeof HBOM_LIFECYCLE_STATUSES)[number];

/** Frozen mirror projection states (lib/store/schema.ts). */
export type HbomCellState =
  | "verified"
  | "proposal"
  | "conflict"
  | "unknown"
  | "not_applicable";

export const HBOM_PART_FIELDS = [
  "partNumber",
  "mpn",
  "manufacturer",
  "description",
  "category",
  "quantity",
  "referenceDesignators",
  "lifecycleStatus",
  "supplier",
  "countryOfOrigin",
  "complianceFlags",
  "fccCoveredList",
  "cryptoRelevant",
  "securityRelevance",
  "firmwareLink",
] as const;

export type HbomPartField = (typeof HBOM_PART_FIELDS)[number];

export interface Acceptance {
  by: string;
  at: string;
}

export interface HbomCandidate<T> {
  value: T | null;
  provenance: Exclude<HbomProvenance, "human">;
  sourceRef?: DocumentSourceRef;
  confidence: number;
  by: string;
  at: string;
}

export interface HbomCell<T> {
  value: T | null;
  provenance?: HbomProvenance;
  sourceRef?: DocumentSourceRef;
  confidence?: number;
  by?: string;
  at?: string;
  note?: string;
  accepted?: Acceptance;
  candidates?: HbomCandidate<T>[];
}

export interface HbomExternalRef {
  type: string;
  url: string;
}

export interface HbomPart {
  id: string;
  asComponentId: string | null;
  boardRevision?: string | null;
  asMissing?: boolean;
  partNumber?: HbomCell<string>;
  mpn?: HbomCell<string>;
  manufacturer?: HbomCell<string>;
  description?: HbomCell<string>;
  category?: HbomCell<HbomCategory>;
  quantity?: HbomCell<number>;
  referenceDesignators?: HbomCell<string[]>;
  lifecycleStatus?: HbomCell<HbomLifecycleStatus>;
  supplier?: HbomCell<string>;
  countryOfOrigin?: HbomCell<string>;
  complianceFlags?: HbomCell<string[]>;
  fccCoveredList?: HbomCell<boolean>;
  cryptoRelevant?: HbomCell<boolean>;
  securityRelevance?: HbomCell<string>;
  firmwareLink?: HbomCell<string>;
  externalRefs?: HbomExternalRef[];
}

export interface HbomDocument {
  schema: typeof HBOM_SCHEMA_ID;
  project: string;
  asProjectId?: string;
  options: {
    reviewThreshold: number;
    exportThreshold: number;
  };
  parts: HbomPart[];
}

export interface HbomReadResult {
  document: HbomDocument;
  sha256: string;
  text: string;
}
