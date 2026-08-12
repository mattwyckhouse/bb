/**
 * Closed remote-service contracts for the Finite State plugin.
 *
 * FROZEN after WP-06 merges. Changes require the contract amendment process.
 * Transport implementations validate upstream data before producing these
 * values; callers never receive transport objects, credentials, or local paths.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type RemoteService =
  | "platform"
  | "assurance-studio"
  | "forge-compute";

export interface RemoteCallContext {
  signal?: AbortSignal;
  requestId?: string;
}

export interface RemotePage<T> {
  items: T[];
  total: number | null;
  /** Opaque continuation token; its value never reveals upstream paging style. */
  next: string | null;
}

export interface RemoteHealth {
  configured: boolean;
  reachable: boolean;
  detail: string | null;
}

export interface RemoteErrorOptions {
  service: RemoteService;
  code: string;
  status: number | null;
  retryable: boolean;
  retryAfterMs: number | null;
  details: Json | null;
}

/** A sanitized service failure with no raw headers, credentials, or response. */
export class RemoteError extends Error {
  readonly service: RemoteService;
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly details: Json | null;

  constructor(message: string, options: RemoteErrorOptions) {
    super(message);
    this.name = "RemoteError";
    this.service = options.service;
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }
}

export interface RemoteArtifact {
  readonly mediaType: string;
  readonly size: number | null;
  readonly sha256: string | null;
  stream(): AsyncIterable<Uint8Array>;
  readJson<T extends Json>(maxBytes: number): Promise<T>;
}

export const VEX_STATUSES = [
  "EXPLOITABLE",
  "IN_TRIAGE",
  "NOT_AFFECTED",
  "FALSE_POSITIVE",
  "RESOLVED",
  "RESOLVED_WITH_PEDIGREE",
] as const;

export const VEX_RESPONSES = [
  "CAN_NOT_FIX",
  "WILL_NOT_FIX",
  "UPDATE",
  "ROLLBACK",
  "WORKAROUND_AVAILABLE",
] as const;

export const VEX_JUSTIFICATIONS = [
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

/** Owner-service chunk size; the Platform endpoint itself permits 5,000. */
export const VEX_RESUMABLE_CHUNK_SIZE = 500;
export const VEX_PLATFORM_MAX_BATCH_SIZE = 5_000;
export const FIRMWARE_RANGE_MAX_BYTES = 131_072;

export type VexStatus = (typeof VEX_STATUSES)[number];
export type VexResponse = (typeof VEX_RESPONSES)[number];
export type VexJustification = (typeof VEX_JUSTIFICATIONS)[number];

export interface VexDecisionInput {
  findingId: string;
  status: VexStatus;
  response?: VexResponse | "";
  justification?: VexJustification | "";
  reason?: string;
}

export interface VexInput extends VexDecisionInput {
  projectVersionId: string;
  dryRun?: boolean;
}

export interface VexBulkSetResult {
  status: "success" | "partial_success" | "failure";
  summary: { total: number; succeeded: number; failed: number };
  /** One result for each request item, in request order. */
  results: {
    findingId: string;
    success: boolean;
    status: VexStatus | null;
    error: string | null;
  }[];
}

export interface ComponentListInput {
  filter?: string;
  excluded?: boolean;
  sort?: string;
  offset?: number;
  limit?: number;
  editStatus?: "any" | "edited" | "unedited";
}

export interface ComponentSearchInput {
  name: string;
  version?: string;
  offset?: number;
  limit?: number;
  sort?: string;
}

export interface PlatformClient {
  health(ctx?: RemoteCallContext): Promise<RemoteHealth>;
  listProjects(
    ctx?: RemoteCallContext,
  ): AsyncIterable<RemotePage<Record<string, Json>>>;
  listVersions(
    projectId: string,
    ctx?: RemoteCallContext,
  ): AsyncIterable<RemotePage<Record<string, Json>>>;
  getFindings(
    input: { projectVersionId: string; offset?: number; limit?: number },
    ctx?: RemoteCallContext,
  ): AsyncIterable<RemotePage<Record<string, Json>>>;
  getFindingDetail(
    input: { projectVersionId: string; findingId: string },
    ctx?: RemoteCallContext,
  ): Promise<Record<string, Json>>;
  getFindingActivity(
    input: {
      projectId: string;
      projectVersionId?: string;
      cve: string;
      cursor?: string;
      limit?: number;
    },
    ctx?: RemoteCallContext,
  ): AsyncIterable<RemotePage<Record<string, Json>>>;
  /** Reads comments embedded by the verified findings endpoint. */
  listFindingComments(
    input: {
      projectVersionId: string;
      findingId: string;
      cursor?: string;
      limit?: number;
    },
    ctx?: RemoteCallContext,
  ): AsyncIterable<RemotePage<Record<string, Json>>>;
  getFindingsSummary(
    projectVersionId: string,
    ctx?: RemoteCallContext,
  ): Promise<Record<string, Json>>;
  setVexStatus(
    input: VexInput,
    ctx?: RemoteCallContext,
  ): Promise<Record<string, Json>>;
  batchSetVexStatus(
    input: { projectVersionId: string; findings: VexDecisionInput[] },
    ctx?: RemoteCallContext,
  ): Promise<VexBulkSetResult>;
  /** Resolves only after the verified 204 response; there is no result body. */
  clearVexStatus(
    input: { projectVersionId: string; findingIds: string[] },
    ctx?: RemoteCallContext,
  ): Promise<void>;
  downloadSbom(
    input: {
      projectVersionId: string;
      format: "cyclonedx" | "spdx";
      includeVex: boolean;
    },
    ctx?: RemoteCallContext,
  ): Promise<RemoteArtifact>;
  listComponents(
    input: ComponentListInput,
    ctx?: RemoteCallContext,
  ): AsyncIterable<RemotePage<Record<string, Json>>>;
  searchComponents(
    input: ComponentSearchInput,
    ctx?: RemoteCallContext,
  ): AsyncIterable<RemotePage<Record<string, Json>>>;
  browseFirmwareFilesystem(
    input: {
      projectVersionId: string;
      path?: string;
      depth?: number;
      fileHash?: string;
      scanId?: string;
    },
    ctx?: RemoteCallContext,
  ): Promise<Record<string, Json>>;
  getFirmwareFile(
    input: FirmwareFileMetadataRequest,
    ctx?: RemoteCallContext,
  ): Promise<Record<string, Json>>;
  getFirmwareFile(
    input: FirmwareFileByteRequest,
    ctx?: RemoteCallContext,
  ): Promise<RemoteArtifact>;
  securityAssessment(
    input: SecurityAssessmentRequest,
    ctx?: RemoteCallContext,
  ): Promise<Json>;
}

export interface FirmwareTreeNode {
  path: string;
  hash: string | null;
  kind: "file" | "directory" | "symlink";
  size: number | null;
  fields: Record<string, Json>;
}

export interface FirmwareFileMetadataRequest {
  projectVersionId: string;
  scanId?: string;
  fileHash: string;
  mode: "meta";
}

export type FirmwareFileByteRequest =
  | {
      projectVersionId: string;
      scanId?: string;
      fileHash: string;
      mode: "range";
      offset: number;
      maxBytes: number;
    }
  | {
      projectVersionId: string;
      scanId?: string;
      fileHash: string;
      mode: "full";
    }
  | { fromScanId: string; fileHash: string; mode: "full" };

export type FirmwareFileRequest =
  | FirmwareFileMetadataRequest
  | FirmwareFileByteRequest;

export const SECURITY_ASSESSMENT_TOOLS = [
  "stp_callgraph",
  "stp_find_binaries_with_symbols",
  "stp_elf_dependency_graph",
  "stp_binary_details",
  "stp_kernel_config",
  "get_scan_quality",
  "stp_architecture",
  "stp_configs",
  "stp_services",
  "stp_crypto",
] as const;

export type SecurityAssessmentTool =
  (typeof SECURITY_ASSESSMENT_TOOLS)[number];

export interface SecurityAssessmentRequest {
  tool: SecurityAssessmentTool;
  projectVersionId: string;
  scanId?: string;
  params?: Record<string, Json>;
}

export type AsEntityKind =
  | "threat"
  | "risk"
  | "mitigation"
  | "asset"
  | "zone"
  | "dataflow"
  | "component"
  | "requirement"
  | "attack-path";

export type AsCreatableEntityKind = Exclude<AsEntityKind, "attack-path">;

export type AsReviewStatus =
  | "pending"
  | "ai_approved"
  | "ai_flagged"
  | "human_approved"
  | "human_rejected";

export interface AsEntity {
  id: string;
  projectId: string;
  kind: AsEntityKind;
  /** Decimal bigint string; never coerce this concurrency token to a number. */
  reviewVersion: string | null;
  reviewStatus: AsReviewStatus | null;
  humanEdited: boolean | null;
  fields: Record<string, Json>;
}

export interface AsWriteResult {
  success: true;
  entity: AsEntity;
  reviewStatusSet: boolean;
  reviewStatusReason: string | null;
}

export interface AsDeleteImpact {
  allowedActions: ("cascade" | "detach")[];
  recommendedAction: "cascade" | "detach" | null;
  references: Json[];
}

/**
 * Client-neutral TARA concurrency values.
 *
 * No TARA state/checkpoint client member is frozen in v1 because the vendored
 * authority does not verify a public route for either operation.
 */
export interface TaraFence {
  expectedHeadVersionId: string;
  expectedWorkingHash?: string;
}

export interface TaraState {
  headVersionId: string;
  workingHash: string | null;
}

export interface AssuranceStudioClient {
  health(ctx?: RemoteCallContext): Promise<RemoteHealth>;
  listEntities(
    kind: AsEntityKind,
    input: {
      projectId: string;
      cursor?: string;
      limit?: number;
      filters?: Record<string, Json>;
    },
    ctx?: RemoteCallContext,
  ): AsyncIterable<RemotePage<AsEntity>>;
  getEntity(
    kind: AsEntityKind,
    input: { projectId: string; id: string },
    ctx?: RemoteCallContext,
  ): Promise<AsEntity>;
  createEntity(
    kind: AsCreatableEntityKind,
    input: { projectId: string; fields: Record<string, Json> },
    ctx?: RemoteCallContext,
  ): Promise<AsWriteResult>;
  updateEntity(
    kind: AsEntityKind,
    input: {
      projectId: string;
      id: string;
      fields: Record<string, Json>;
      force?: boolean;
    },
    ctx?: RemoteCallContext,
  ): Promise<AsWriteResult>;
  deleteEntity(
    kind: AsEntityKind,
    input: {
      projectId: string;
      id: string;
      mode?: "cascade" | "detach";
      force?: boolean;
    },
    ctx?: RemoteCallContext,
  ): Promise<
    { success: true } | { success: false; impact: AsDeleteImpact }
  >;
  listProjectSbomPackages(
    input: {
      projectId: string;
      cursor?: string;
      limit?: number;
      filters?: Record<string, Json>;
    },
    ctx?: RemoteCallContext,
  ): AsyncIterable<RemotePage<Record<string, Json>>>;
  listVerificationChecks(
    input: {
      projectId: string;
      status?: string;
      type?: string;
      requirementId?: string;
      cursor?: string;
      limit?: number;
    },
    ctx?: RemoteCallContext,
  ): AsyncIterable<RemotePage<Record<string, Json>>>;
  /** Includes the check's verified historical `results` collection. */
  getVerificationCheck(
    input: { projectId: string; checkId: string },
    ctx?: RemoteCallContext,
  ): Promise<Record<string, Json>>;
  runVerificationChecks(
    input: {
      projectId: string;
      checkIds?: string[];
      rerunPassed?: boolean;
    },
    ctx?: RemoteCallContext,
  ): Promise<{ runId: string; checksQueued: number; status: string }>;
}

export const FORGE_JOB_STATUSES = [
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "TIMEOUT",
] as const;

export const FORGE_JOB_TERMINAL_STATUSES = [
  "COMPLETED",
  "FAILED",
  "TIMEOUT",
] as const;

export const FORGE_COMPUTE_TOOLS = ["verify_dynamic", "pen_test_run"] as const;

export type ForgeJobStatus = (typeof FORGE_JOB_STATUSES)[number];
export type ForgeJobTerminalStatus =
  (typeof FORGE_JOB_TERMINAL_STATUSES)[number];
export type ForgeComputeTool = (typeof FORGE_COMPUTE_TOOLS)[number];

export interface ForgeJobError {
  code: string;
  message: string | null;
}

export interface ForgeJobSnapshot {
  jobId: string;
  status: ForgeJobStatus;
  tool: ForgeComputeTool;
  recipe: string | null;
  scope: Json;
  environment: Json;
  runId: string | null;
  elapsedSeconds: number;
  logTail: string[];
  events: Json[];
  eventCount: number;
  result: Json | null;
  /** Raw CANCELLED is represented as FAILED with FORGE_JOB_CANCELLED here. */
  error: ForgeJobError | null;
}

export interface ForgeDeploymentContext {
  productType: string;
  networkExposure: string;
  regulatory: string;
  deploymentNotes: string;
  rootComponentName: string;
  rootComponentType: string;
}

export interface ForgePenTestInput {
  cveId: string;
  componentId: string;
  projectId: string;
  projectVersionId: string;
  findingId?: string | null;
  profileHint?: string | null;
  tenantId?: string;
  deploymentContext?: ForgeDeploymentContext | null;
  budget?: Record<string, Json> | null;
  replaySeed?: number;
  authoringEnabled?: boolean;
  blind?: boolean;
  confidenceFloor?: number | null;
  llmProvider?: "anthropic" | "openai" | "google" | null;
  llmModel?: string | null;
}

export interface ForgeComputeClient {
  health(ctx?: RemoteCallContext): Promise<RemoteHealth>;
  verifyDynamic(
    input: {
      projectVersionId: string;
      verdictIds: string[];
      budgetSecPerVerdict?: number;
    },
    ctx?: RemoteCallContext,
  ): Promise<Json>;
  penTestRun(
    input: ForgePenTestInput,
    ctx?: RemoteCallContext,
  ): Promise<{ jobId: string }>;
  getJobStatus(
    jobId: string,
    tailLines?: number,
    ctx?: RemoteCallContext,
  ): Promise<ForgeJobSnapshot>;
  listJobs(
    input?: { status?: ForgeJobStatus; tool?: ForgeComputeTool },
    ctx?: RemoteCallContext,
  ): AsyncIterable<RemotePage<ForgeJobSnapshot>>;
  watchJob(
    jobId: string,
    ctx?: RemoteCallContext,
  ): AsyncIterable<ForgeJobSnapshot>;
}

export interface RemoteServices {
  platform: PlatformClient;
  assuranceStudio: AssuranceStudioClient;
  forgeCompute: ForgeComputeClient | null;
}
