import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AsEntity,
  AssuranceStudioClient,
  Json,
} from "../../../../lib/remote/types.js";
import { ASSURANCE_STUDIO_MAX_PAGE_SIZE } from "../../../../lib/remote/assurance-studio/client.js";
import { ENTITIES } from "../../../../lib/sync/registry.js";
import {
  type EntityAdapter,
  type ServerEntity,
  type SyncScope,
  type WorkingEntity,
} from "../../../sync/engine/adapter.js";
import { createSerializer } from "../../../sync/serialize/serializer.js";
import {
  architectureEntityPayload,
  criticalitySchema,
  parseArchitectureEntity,
  strideCategorySchema,
  threatSourceSchema,
  type ArchitectureYamlEntity,
  type CanvasEntityKind,
} from "./schema.js";
import { parseCanvasEntity, canvasEntityFile } from "./writer.js";

export interface AdapterSlugResolver {
  remoteToSlug(
    scope: SyncScope,
    kind: CanvasEntityKind | "mitigation",
    remoteId: string,
  ): string | null;
  slugToRemote(
    scope: SyncScope,
    kind: CanvasEntityKind | "mitigation",
    slug: string,
  ): string | null;
}

const REMOTE_FIELDS = {
  common: {
    name: ["name", "title", "label"],
    description: ["description", "summary"],
  },
  component: {
    componentType: ["component_type", "componentType", "type"],
    criticality: ["criticality"],
    zone: ["zone_id", "zone"],
    interfaces: ["interfaces"],
    technologies: ["technologies"],
    entryPoint: ["is_entry_point", "isEntryPoint"],
    storesData: ["stores_data", "storesData", "is_data_store", "isDataStore"],
  },
  zone: {
    trustLevel: ["trust_level", "trustLevel"],
    parent: ["parent_zone_id", "parent_zone", "zone"],
  },
  asset: {
    criticality: ["criticality", "business_value"],
    assetType: ["asset_type", "assetType", "type"],
    zone: ["zone_id", "zone"],
    dataClassification: ["data_classification"],
  },
  dataflow: {
    source: ["source_component_id", "from_component", "from"],
    target: ["target_component_id", "to_component", "to"],
    protocol: ["protocol"],
    dataTypes: ["data_types", "dataTypes"],
    encrypted: ["is_encrypted", "encrypted"],
    authenticated: ["is_authenticated", "authenticated"],
    bidirectional: ["is_bidirectional", "bidirectional"],
  },
  threat: {
    category: ["category", "stride_category", "stride_categories"],
    threatSource: ["threat_source", "threatSource"],
    severity: ["severity"],
    components: ["affected_component_ids", "affected_components"],
    assets: ["asset_ids", "affected_asset_ids", "affected_assets"],
    dataflows: ["affected_dataflow_ids", "affected_dataflows"],
    mitigations: ["mitigation_ids", "mitigations", "linked_mitigations"],
    assumptions: ["preconditions", "assumptions"],
  },
} as const;

/**
 * Required read groups used by the production adapter and its real-wire
 * adversarial contract test. A group is satisfied by any one listed AS alias.
 */
export const TARA_REMOTE_REQUIRED_FIELD_GROUPS = {
  component: [
    REMOTE_FIELDS.common.name,
    REMOTE_FIELDS.component.componentType,
    REMOTE_FIELDS.component.criticality,
    REMOTE_FIELDS.component.interfaces,
    REMOTE_FIELDS.component.technologies,
    REMOTE_FIELDS.component.entryPoint,
    REMOTE_FIELDS.component.storesData,
  ],
  zone: [REMOTE_FIELDS.common.name, REMOTE_FIELDS.zone.trustLevel],
  asset: [
    REMOTE_FIELDS.common.name,
    REMOTE_FIELDS.asset.assetType,
    REMOTE_FIELDS.asset.criticality,
  ],
  dataflow: [
    REMOTE_FIELDS.common.name,
    REMOTE_FIELDS.dataflow.source,
    REMOTE_FIELDS.dataflow.target,
    REMOTE_FIELDS.dataflow.dataTypes,
    REMOTE_FIELDS.dataflow.encrypted,
    REMOTE_FIELDS.dataflow.authenticated,
    REMOTE_FIELDS.dataflow.bidirectional,
  ],
  threat: [
    REMOTE_FIELDS.common.name,
    REMOTE_FIELDS.threat.category,
    REMOTE_FIELDS.threat.threatSource,
    REMOTE_FIELDS.threat.assets,
    REMOTE_FIELDS.threat.mitigations,
  ],
} as const satisfies Readonly<
  Record<CanvasEntityKind, readonly (readonly string[])[]>
>;

function optional<T extends Json>(
  field: string,
  value: T | undefined,
): Record<string, Json> {
  return value === undefined ? {} : { [field]: value };
}

function commonFields(entity: ArchitectureYamlEntity): Record<string, Json> {
  return {
    slug: entity.slug,
    name: entity.name,
    ...optional("description", entity.description),
  };
}

function requireRemote(
  resolver: AdapterSlugResolver,
  scope: SyncScope,
  kind: CanvasEntityKind | "mitigation",
  slug: string,
): string {
  const remoteId = resolver.slugToRemote(scope, kind, slug);
  if (!remoteId) {
    throw new Error(
      `UNRESOLVED_SLUG: ${kind} “${slug}” has no accepted id_map binding.`,
    );
  }
  return remoteId;
}

export function projectCreateFields(
  entity: ArchitectureYamlEntity,
  scope: SyncScope,
  resolver: AdapterSlugResolver,
): Record<string, Json> {
  const common = commonFields(entity);
  switch (entity.kind) {
    case "component":
      return {
        ...common,
        component_type: entity.component_type,
        criticality: entity.criticality,
        ...optional(
          "zone_id",
          entity.zone
            ? requireRemote(resolver, scope, "zone", entity.zone)
            : undefined,
        ),
        interfaces: entity.interfaces,
        technologies: entity.technologies,
        is_entry_point: entity.is_entry_point,
        stores_data: entity.stores_data,
      };
    case "zone":
      return {
        ...common,
        trust_level: entity.trust_level,
        ...optional(
          "parent_zone_id",
          entity.zone
            ? requireRemote(resolver, scope, "zone", entity.zone)
            : undefined,
        ),
      };
    case "asset":
      return {
        ...common,
        asset_type: entity.asset_type,
        // Assurance Studio POST names this value business_value.
        business_value: entity.criticality,
        ...optional(
          "zone_id",
          entity.zone
            ? requireRemote(resolver, scope, "zone", entity.zone)
            : undefined,
        ),
        ...optional("data_classification", entity.data_classification),
      };
    case "dataflow":
      return {
        ...common,
        // POST and PATCH intentionally use different upstream field names.
        source_component_id: requireRemote(
          resolver,
          scope,
          "component",
          entity.from,
        ),
        target_component_id: requireRemote(
          resolver,
          scope,
          "component",
          entity.to,
        ),
        ...optional("protocol", entity.protocol),
        data_types: entity.data_types,
        is_encrypted: entity.encrypted,
        is_authenticated: entity.authenticated,
        is_bidirectional: entity.bidirectional,
      };
    case "threat":
      return {
        ...common,
        category: entity.category,
        threat_source: entity.threat_source,
        severity: entity.severity,
        affected_component_ids: entity.affected_components.map((slug) =>
          requireRemote(resolver, scope, "component", slug),
        ),
        affected_asset_ids: entity.affected_assets.map((slug) =>
          requireRemote(resolver, scope, "asset", slug),
        ),
        affected_dataflow_ids: entity.dataflows.map((slug) =>
          requireRemote(resolver, scope, "dataflow", slug),
        ),
        mitigation_ids: entity.mitigations.map((slug) =>
          requireRemote(resolver, scope, "mitigation", slug),
        ),
        assumptions: entity.assumptions,
      };
  }
}

export function projectPatchFields(
  entity: ArchitectureYamlEntity,
  scope: SyncScope,
  resolver: AdapterSlugResolver,
): Record<string, Json> {
  if (entity.kind === "asset") {
    const projected = projectCreateFields(entity, scope, resolver);
    const { business_value: _businessValue, ...rest } = projected;
    return { ...rest, criticality: entity.criticality };
  }
  if (entity.kind === "dataflow") {
    const common = commonFields(entity);
    return {
      ...common,
      from_component: requireRemote(resolver, scope, "component", entity.from),
      to_component: requireRemote(resolver, scope, "component", entity.to),
      ...optional("protocol", entity.protocol),
      data_types: entity.data_types,
      encrypted: entity.encrypted,
      authenticated: entity.authenticated,
      bidirectional: entity.bidirectional,
    };
  }
  return projectCreateFields(entity, scope, resolver);
}

function stringField(
  fields: Record<string, Json>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function requiredStringField(
  kind: CanvasEntityKind,
  fields: Record<string, Json>,
  ...names: string[]
): string {
  const value = stringField(fields, ...names);
  if (value) return value;
  throw new Error(
    `REMOTE_FIELD_MISSING: ${kind} payload lacks ${names.join("/")}.`,
  );
}

function requiredSingleStringField(
  kind: CanvasEntityKind,
  fields: Record<string, Json>,
  ...names: string[]
): string {
  const scalar = stringField(fields, ...names);
  if (scalar) return scalar;
  for (const name of names) {
    const value = fields[name];
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      if (value.length === 1 && value[0]!.trim().length > 0) return value[0]!;
      if (value.length > 1) {
        throw new Error(
          `REMOTE_FIELD_UNSUPPORTED: ${kind} payload has ${value.length} ${name} values; authored YAML supports one category.`,
        );
      }
    }
  }
  throw new Error(
    `REMOTE_FIELD_MISSING: ${kind} payload lacks ${names.join("/")}.`,
  );
}

function isJson(value: unknown): value is Json {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item));
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((item) => isJson(item))
  );
}

function requiredBooleanField(
  kind: CanvasEntityKind,
  fields: Record<string, Json>,
  ...names: string[]
): boolean {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "boolean") return value;
  }
  throw new Error(
    `REMOTE_FIELD_MISSING: ${kind} payload lacks ${names.join("/")}.`,
  );
}

function requiredStringList(
  kind: CanvasEntityKind,
  fields: Record<string, Json>,
  ...names: string[]
): string[] {
  for (const name of names) {
    const value = fields[name];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value;
    }
  }
  throw new Error(
    `REMOTE_FIELD_MISSING: ${kind} payload lacks ${names.join("/")}.`,
  );
}

function stringListField(
  fields: Record<string, Json>,
  ...names: string[]
): string[] | undefined {
  for (const name of names) {
    const value = fields[name];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value;
    }
  }
  return undefined;
}

function remoteReference(
  fields: Record<string, Json>,
  resolver: AdapterSlugResolver,
  scope: SyncScope,
  kind: CanvasEntityKind | "mitigation",
  ...names: string[]
): string | undefined {
  const value = stringField(fields, ...names);
  if (!value) return undefined;
  return resolver.remoteToSlug(scope, kind, value) ?? derivedRemoteSlug(kind, value);
}

function requiredRemoteReference(
  ownerKind: CanvasEntityKind,
  fields: Record<string, Json>,
  resolver: AdapterSlugResolver,
  scope: SyncScope,
  targetKind: CanvasEntityKind | "mitigation",
  ...names: string[]
): string {
  const reference = remoteReference(
    fields,
    resolver,
    scope,
    targetKind,
    ...names,
  );
  if (reference) return reference;
  throw new Error(
    `REMOTE_FIELD_MISSING: ${ownerKind} payload lacks ${names.join("/")}.`,
  );
}

function referenceIds(value: Json): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      ids.push(item);
      continue;
    }
    if (
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      typeof item["id"] === "string"
    ) {
      ids.push(item["id"]);
      continue;
    }
    return null;
  }
  return ids;
}

function referenceListField(
  fields: Record<string, Json>,
  ...names: string[]
): string[] | undefined {
  for (const name of names) {
    const value = fields[name];
    if (value === undefined) continue;
    const ids = referenceIds(value);
    if (ids !== null) return ids;
  }
  return undefined;
}

function remoteReferenceList(
  fields: Record<string, Json>,
  resolver: AdapterSlugResolver,
  scope: SyncScope,
  kind: CanvasEntityKind | "mitigation",
  ...names: string[]
): string[] {
  const references = referenceListField(fields, ...names);
  if (!references) {
    throw new Error(
      `REMOTE_FIELD_MISSING: ${kind} reference list lacks ${names.join("/")}.`,
    );
  }
  return references.map((value) => {
    return resolver.remoteToSlug(scope, kind, value) ?? derivedRemoteSlug(kind, value);
  });
}

function optionalRemoteReferenceList(
  fields: Record<string, Json>,
  resolver: AdapterSlugResolver,
  scope: SyncScope,
  kind: CanvasEntityKind | "mitigation",
  ...names: string[]
): string[] | undefined {
  const references = referenceListField(fields, ...names);
  return references?.map((value) =>
    resolver.remoteToSlug(scope, kind, value) ?? derivedRemoteSlug(kind, value)
  );
}

function derivedRemoteSlug(
  kind: CanvasEntityKind | "mitigation",
  remoteId: string,
): string {
  // Fresh pulls must resolve a referenced remote ID before its entity may have
  // been fetched, so the fallback must be derivable from the ID alone. Including
  // a name would make the result order-dependent and can break cross-kind links.
  const identity = createHash("sha256").update(remoteId).digest("hex").slice(0, 20);
  return `${kind}-${identity}`;
}

function remotePayload(
  kind: CanvasEntityKind,
  remoteId: string,
  fields: Record<string, Json>,
  scope: SyncScope,
  resolver: AdapterSlugResolver,
): Record<string, unknown> {
  const slug = resolver.remoteToSlug(scope, kind, remoteId)
    ?? derivedRemoteSlug(kind, remoteId);
  const name = stringField(fields, ...REMOTE_FIELDS.common.name);
  if (!name) throw new Error(`${kind} remote payload lacks name.`);
  const description = stringField(fields, ...REMOTE_FIELDS.common.description);
  const common = { slug, name, ...optional("description", description) };
  switch (kind) {
    case "component":
      return {
        ...common,
        component_type: requiredStringField(
          kind,
          fields,
          ...REMOTE_FIELDS.component.componentType,
        ),
        criticality: requiredStringField(
          kind,
          fields,
          ...REMOTE_FIELDS.component.criticality,
        ),
        ...optional(
          "zone",
          remoteReference(
            fields,
            resolver,
            scope,
            "zone",
            ...REMOTE_FIELDS.component.zone,
          ),
        ),
        // AS returns interface labels; authored YAML wraps each label in its
        // richer local interface object without inventing protocol metadata.
        interfaces: requiredStringList(
          kind,
          fields,
          ...REMOTE_FIELDS.component.interfaces,
        ).map((interfaceName) => ({ name: interfaceName })),
        technologies: requiredStringList(
          kind,
          fields,
          ...REMOTE_FIELDS.component.technologies,
        ),
        is_entry_point: requiredBooleanField(
          kind,
          fields,
          ...REMOTE_FIELDS.component.entryPoint,
        ),
        stores_data: requiredBooleanField(
          kind,
          fields,
          ...REMOTE_FIELDS.component.storesData,
        ),
      };
    case "zone":
      return {
        ...common,
        trust_level: requiredStringField(
          kind,
          fields,
          ...REMOTE_FIELDS.zone.trustLevel,
        ),
        ...optional(
          "zone",
          remoteReference(
            fields,
            resolver,
            scope,
            "zone",
            ...REMOTE_FIELDS.zone.parent,
          ),
        ),
      };
    case "asset": {
      const criticality = requiredStringField(
        kind,
        fields,
        ...REMOTE_FIELDS.asset.criticality,
      );
      criticalitySchema.parse(criticality);
      return {
        ...common,
        asset_type: requiredStringField(
          kind,
          fields,
          ...REMOTE_FIELDS.asset.assetType,
        ),
        criticality,
        ...optional(
          "zone",
          remoteReference(
            fields,
            resolver,
            scope,
            "zone",
            ...REMOTE_FIELDS.asset.zone,
          ),
        ),
        ...optional(
          "data_classification",
          stringField(fields, ...REMOTE_FIELDS.asset.dataClassification),
        ),
      };
    }
    case "dataflow":
      return {
        ...common,
        from: requiredRemoteReference(
          kind,
          fields,
          resolver,
          scope,
          "component",
          ...REMOTE_FIELDS.dataflow.source,
        ),
        to: requiredRemoteReference(
          kind,
          fields,
          resolver,
          scope,
          "component",
          ...REMOTE_FIELDS.dataflow.target,
        ),
        ...optional(
          "protocol",
          stringField(fields, ...REMOTE_FIELDS.dataflow.protocol),
        ),
        data_types: requiredStringList(
          kind,
          fields,
          ...REMOTE_FIELDS.dataflow.dataTypes,
        ),
        encrypted: requiredBooleanField(
          kind,
          fields,
          ...REMOTE_FIELDS.dataflow.encrypted,
        ),
        authenticated: requiredBooleanField(
          kind,
          fields,
          ...REMOTE_FIELDS.dataflow.authenticated,
        ),
        bidirectional: requiredBooleanField(
          kind,
          fields,
          ...REMOTE_FIELDS.dataflow.bidirectional,
        ),
      };
    case "threat":
      return {
        ...common,
        category: requiredSingleStringField(
          kind,
          fields,
          ...REMOTE_FIELDS.threat.category,
        ),
        threat_source: requiredStringField(
          kind,
          fields,
          ...REMOTE_FIELDS.threat.threatSource,
        ),
        // AS's Threat response has no threat severity field. Keep it absent
        // instead of fabricating one from the semantically different risk_level.
        ...optional(
          "severity",
          stringField(fields, ...REMOTE_FIELDS.threat.severity),
        ),
        ...optional(
          "affected_components",
          optionalRemoteReferenceList(
            fields,
            resolver,
            scope,
            "component",
            ...REMOTE_FIELDS.threat.components,
          ),
        ),
        affected_assets: remoteReferenceList(
          fields,
          resolver,
          scope,
          "asset",
          ...REMOTE_FIELDS.threat.assets,
        ),
        // AS does not return a threat-to-dataflow relation. Omission preserves
        // that unknown state instead of asserting an empty remote relation.
        ...optional(
          "dataflows",
          optionalRemoteReferenceList(
            fields,
            resolver,
            scope,
            "dataflow",
            ...REMOTE_FIELDS.threat.dataflows,
          ),
        ),
        mitigations: remoteReferenceList(
          fields,
          resolver,
          scope,
          "mitigation",
          ...REMOTE_FIELDS.threat.mitigations,
        ),
        ...optional(
          "assumptions",
          stringListField(fields, ...REMOTE_FIELDS.threat.assumptions),
        ),
      };
  }
}

function canonicalRemotePayload(
  kind: CanvasEntityKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (kind !== "threat") {
    return architectureEntityPayload(parseArchitectureEntity(kind, payload));
  }
  strideCategorySchema.parse(payload["category"]);
  threatSourceSchema.parse(payload["threat_source"]);
  if (payload["severity"] !== undefined) {
    criticalitySchema.parse(payload["severity"]);
  }
  return payload;
}

export function projectRemoteEntity(
  kind: CanvasEntityKind,
  remote: AsEntity,
  scope: SyncScope,
  resolver: AdapterSlugResolver,
): ServerEntity {
  if (remote.kind !== kind) {
    throw new Error(
      `Assurance Studio returned ${remote.kind} in a ${kind} page.`,
    );
  }
  const semantic = createSerializer(kind).semanticPayload({
    id: remote.id,
    projectId: remote.projectId,
    kind: remote.kind,
    reviewVersion: remote.reviewVersion,
    reviewStatus: remote.reviewStatus,
    humanEdited: remote.humanEdited,
    fields: remote.fields,
  });
  const fields: Record<string, Json> = {};
  for (const [field, value] of Object.entries(semantic)) {
    if (isJson(value)) {
      fields[field] = value;
    }
  }
  const payload = canonicalRemotePayload(
    kind,
    remotePayload(kind, remote.id, fields, scope, resolver),
  );
  return {
    key: ENTITIES[kind].key(payload),
    remoteId: remote.id,
    // The sync engine owns the one semanticPayload() call for remote rows.
    // Re-wrap the canonical, id_map-resolved fields in its expected envelope
    // so plan, status, and pull all observe the same authored projection.
    payload: {
      id: remote.id,
      projectId: remote.projectId,
      kind: remote.kind,
      reviewVersion: remote.reviewVersion,
      reviewStatus: remote.reviewStatus,
      humanEdited: remote.humanEdited,
      fields: payload,
    },
  };
}

function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readWorkingKind(
  worktreeRoot: string,
  kind: CanvasEntityKind,
): Promise<WorkingEntity[]> {
  const directory = ENTITIES[kind].dir;
  let entries;
  try {
    entries = await readdir(join(worktreeRoot, directory), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isMissingDirectory(error)) return [];
    throw error;
  }
  const documents: WorkingEntity[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!/\.ya?ml$/iu.test(entry.name)) continue;
    if (!entry.isFile()) {
      throw new Error(
        `${directory}/${entry.name} must be a regular YAML file.`,
      );
    }
    const file = `${directory}/${entry.name}`;
    const content = await readFile(join(worktreeRoot, file), "utf8");
    const entity = parseCanvasEntity(kind, content, file);
    const expectedFile = canvasEntityFile(kind, entity.slug);
    if (file !== expectedFile) {
      throw new Error(
        `${file} declares slug ${entity.slug}; expected ${expectedFile}.`,
      );
    }
    const payload = architectureEntityPayload(entity);
    documents.push({ key: ENTITIES[kind].key(payload), payload, file });
  }
  return documents;
}

function createAdapter(
  kind: CanvasEntityKind,
  client: AssuranceStudioClient,
  resolver: AdapterSlugResolver,
): EntityAdapter {
  return {
    kind,
    klass: "VERSIONED",
    serializer: createSerializer(kind),
    async *fetchRemote(scope, onProgress) {
      let pageNumber = 0;
      for await (const page of client.listEntities(kind, {
        projectId: scope.projectId,
        page: { pageSize: ASSURANCE_STUDIO_MAX_PAGE_SIZE },
      })) {
        pageNumber += 1;
        onProgress({
          page: pageNumber,
          of:
            page.total === null
              ? null
              : Math.ceil(page.total / ASSURANCE_STUDIO_MAX_PAGE_SIZE),
        });
        yield page.items.map((remote) =>
          projectRemoteEntity(kind, remote, scope, resolver),
        );
      }
    },
    readWorking(worktreeRoot) {
      return readWorkingKind(worktreeRoot, kind);
    },
  };
}

export function createCanvasEntityAdapters(
  client: AssuranceStudioClient,
  resolver: AdapterSlugResolver,
): readonly EntityAdapter[] {
  return (["component", "zone", "asset", "dataflow", "threat"] as const).map(
    (kind) => createAdapter(kind, client, resolver),
  );
}
