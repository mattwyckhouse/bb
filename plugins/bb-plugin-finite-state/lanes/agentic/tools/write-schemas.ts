import { z } from "zod";
import {
  documentSourceRefSchema,
  sha256Schema,
} from "../../../shared/contract.js";
import { HBOM_PART_FIELDS } from "../../bom/hbom/types.js";

// Frozen VEX vocabulary — keep identical to the Platform VEX enums owned by
// the remote-types contract. Agentic write modules must not import remote
// clients (closed action-tool boundary).
const VEX_STATUSES = [
  "EXPLOITABLE",
  "IN_TRIAGE",
  "NOT_AFFECTED",
  "FALSE_POSITIVE",
  "RESOLVED",
  "RESOLVED_WITH_PEDIGREE",
] as const;
const VEX_RESPONSES = [
  "CAN_NOT_FIX",
  "WILL_NOT_FIX",
  "UPDATE",
  "ROLLBACK",
  "WORKAROUND_AVAILABLE",
] as const;
const VEX_JUSTIFICATIONS = [
  "CODE_NOT_PRESENT",
  "CODE_NOT_REACHABLE",
  "REQUIRES_CONFIGURATION",
  "REQUIRES_DEPENDENCY",
  "REQUIRES_ENVIRONMENT",
  "PROTECTED_BY_COMPILER",
  "PROTECTED_AT_RUNTIME",
  "PROTECTED_AT_PERIMETER",
  "PROTECTED_BY_MITIGATING_CONTROL",
] as const;

const identifier = z.string().trim().min(1).max(512);
const evidenceSchema = z.string().trim().min(1).max(20_000);
const reasonSchema = z.string().trim().min(12).max(10_000);

export const triageSetSchema = z
  .object({
    projectVersionId: identifier,
    stableKey: identifier,
    status: z.enum(VEX_STATUSES),
    justification: z.enum(VEX_JUSTIFICATIONS).nullable().default(null),
    response: z.enum(VEX_RESPONSES).nullable().default(null),
    reason: reasonSchema,
    pin: z.enum(["exact_version", "any_version"]).optional(),
    evidence: evidenceSchema,
    expectedHash: sha256Schema.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.status === "NOT_AFFECTED" && item.justification === null) {
      context.addIssue({
        code: "custom",
        path: ["justification"],
        message: "NOT_AFFECTED requires a frozen VEX justification",
      });
    }
    if (item.status !== "NOT_AFFECTED" && item.justification !== null) {
      context.addIssue({
        code: "custom",
        path: ["justification"],
        message: "Justification is only valid for NOT_AFFECTED",
      });
    }
    if (
      item.justification === "CODE_NOT_REACHABLE" &&
      item.pin === "any_version"
    ) {
      context.addIssue({
        code: "custom",
        path: ["pin"],
        message: "CODE_NOT_REACHABLE requires exact_version",
      });
    }
  });

export const triageApplyPolicySchema = z
  .object({
    projectVersionId: identifier,
    dryRun: z.boolean().default(false),
  })
  .strict();

/**
 * Canonical requirement payload is a parsed YAML object (not a string).
 * Gate 1 validates the object; string YAML would create a second drifting path.
 */
export const requirementWriteSchema = z
  .object({
    reqId: z
      .string()
      .trim()
      .min(5)
      .max(512)
      .regex(/^REQ-[A-Za-z0-9][A-Za-z0-9-]*$/u, "must be a REQ-* stable id"),
    yaml: z.record(z.string(), z.unknown()),
    expectedHash: sha256Schema.optional(),
  })
  .strict();

const hbomPartSchema = z.union([
  z.object({ id: identifier }).strict(),
  z
    .object({
      mpn: z.string().trim().min(1).max(512).optional(),
      referenceDesignator: z.string().trim().min(1).max(512).optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.mpn !== undefined || value.referenceDesignator !== undefined,
      "Part identity requires mpn and/or referenceDesignator when id is omitted",
    ),
]);

export const hbomExtractSchema = z
  .object({
    projectVersionId: identifier.nullable().default(null),
    documentSha256: sha256Schema,
    expectedHbomSha256: sha256Schema,
    createMissingParts: z.boolean().default(false),
    cells: z
      .array(
        z
          .object({
            part: hbomPartSchema,
            field: z.enum(HBOM_PART_FIELDS),
            value: z.unknown(),
            source_ref: documentSourceRefSchema,
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

export type TriageSetInput = z.infer<typeof triageSetSchema>;
export type TriageApplyPolicyInput = z.infer<typeof triageApplyPolicySchema>;
export type RequirementWriteInput = z.infer<typeof requirementWriteSchema>;
export type HbomExtractInput = z.infer<typeof hbomExtractSchema>;
