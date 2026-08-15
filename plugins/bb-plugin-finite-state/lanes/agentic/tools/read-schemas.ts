import { z } from "zod";

const identifier = z.string().trim().min(1).max(512);
const opaqueCursor = z.string().trim().min(1).max(4_096);
const pageLimit = z.number().int().min(1).max(200).default(50);

export const syncStatusSchema = z
  .object({
    projectId: identifier,
    projectVersionId: z.string().trim().min(1).max(512).nullable().optional(),
    surface: identifier.optional(),
  })
  .strict();

export const syncPlanSchema = z
  .object({
    projectId: identifier,
    projectVersionId: z.string().trim().min(1).max(512).nullable().optional(),
    surface: identifier.optional(),
    cursor: opaqueCursor.optional(),
    limit: pageLimit,
  })
  .strict();

export const findingsQuerySchema = z
  .object({
    projectId: identifier,
    version: identifier,
    component: identifier.optional(),
    cve: identifier.optional(),
    severity: z.array(identifier).max(32).optional(),
    reachability: z.enum(["reachable", "unreachable", "unknown"]).optional(),
    kev: z.enum(["kev", "vc-kev", "none"]).optional(),
    epss_gte: z.number().min(0).max(1).optional(),
    triage: z.array(identifier).max(32).optional(),
    finding_type: z.array(identifier).max(32).optional(),
    cursor: opaqueCursor.optional(),
    limit: pageLimit,
  })
  .strict();

export const taraQuerySchema = z
  .object({
    projectId: identifier,
    projectVersionId: z.string().trim().min(1).max(512).nullable().optional(),
    kind: z.enum([
      "threat",
      "component",
      "zone",
      "dataflow",
      "asset",
      "requirement",
      "verification",
      "attack_path",
      "clause",
      "trace",
    ]),
    filter: z.record(z.string(), z.string()).optional(),
    cursor: opaqueCursor.optional(),
    limit: pageLimit,
  })
  .strict();

export const earsConvertSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("bundle"),
      projectId: identifier,
      projectVersionId: z.string().trim().min(1).max(512).nullable().optional(),
      req_ids: z.array(identifier).max(500).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("validate"),
      paths: z.array(z.string().trim().min(1).max(4_096)).min(1).max(500),
      bundleId: identifier.optional(),
    })
    .strict(),
]);

export const sbomQuerySchema = z
  .object({
    projectId: identifier,
    version: identifier,
    name: identifier.optional(),
    purl: identifier.optional(),
    license: identifier.optional(),
    license_group: identifier.optional(),
    min_severity: z.enum(["critical", "high", "medium", "low"]).optional(),
    kev: z.boolean().optional(),
    reachability: z
      .enum(["reachable", "unreachable", "mixed", "unknown"])
      .optional(),
    linked: z.boolean().optional(),
    cursor: opaqueCursor.optional(),
    limit: pageLimit,
  })
  .strict();

export const hbomReviewSchema = z
  .object({
    projectId: identifier,
    projectVersionId: z.string().trim().min(1).max(512).nullable().optional(),
    state: z.enum(["review", "conflict", "all"]).default("all"),
    cursor: opaqueCursor.optional(),
    limit: pageLimit,
  })
  .strict();

export const benchStatusSchema = z
  .object({
    projectId: identifier,
    pv_id: identifier.optional(),
    run_id: identifier.optional(),
    want: z.enum(["runs", "results", "artifacts", "verdict"]).default("runs"),
    cursor: opaqueCursor.optional(),
    limit: pageLimit,
  })
  .strict();

export const docSearchSchema = z
  .object({
    project_id: identifier,
    project_version_id: z.string().trim().min(1).max(512).nullable().optional(),
    query: z.string().trim().min(1).max(1_024),
    doc_type: identifier.optional(),
    cursor: opaqueCursor.optional(),
    limit: pageLimit,
  })
  .strict();

export type SyncStatusInput = z.infer<typeof syncStatusSchema>;
export type SyncPlanInput = z.infer<typeof syncPlanSchema>;
export type FindingsQueryInput = z.infer<typeof findingsQuerySchema>;
export type TaraQueryInput = z.infer<typeof taraQuerySchema>;
export type EarsConvertInput = z.infer<typeof earsConvertSchema>;
export type SbomQueryInput = z.infer<typeof sbomQuerySchema>;
export type HbomReviewInput = z.infer<typeof hbomReviewSchema>;
export type BenchStatusInput = z.infer<typeof benchStatusSchema>;
export type DocSearchInput = z.infer<typeof docSearchSchema>;
