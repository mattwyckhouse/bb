import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIRMWARE_RANGE_MAX_BYTES,
  FORGE_COMPUTE_TOOLS,
  FORGE_JOB_STATUSES,
  FORGE_JOB_TERMINAL_STATUSES,
  RemoteError,
  SECURITY_ASSESSMENT_TOOLS,
  VEX_JUSTIFICATIONS,
  VEX_PLATFORM_MAX_BATCH_SIZE,
  VEX_RESPONSES,
  VEX_RESUMABLE_CHUNK_SIZE,
  VEX_STATUSES,
  type AsEntity,
  type AsWriteResult,
  type AssuranceStudioClient,
  type ForgeComputeClient,
  type FirmwareFileByteRequest,
  type FirmwareFileMetadataRequest,
  type FirmwareFileRequest,
  type ForgeJobError,
  type ForgeJobSnapshot,
  type ForgeJobStatus,
  type Json,
  type PlatformClient,
  type RemoteArtifact,
  type RemoteCallContext,
  type RemotePage,
  type RemoteServices,
} from "./types.js";

const apiReferenceRoot = resolve(
  import.meta.dirname,
  "../../docs/Implementation/api-reference",
);

async function* emptyPages<T>(): AsyncIterable<RemotePage<T>> {}
async function* emptyItems<T>(): AsyncIterable<T> {}

const streamedJson = new TextEncoder().encode('{"ok":true}');
const streamedJsonChunks = [streamedJson.slice(0, 5), streamedJson.slice(5)];

const artifact: RemoteArtifact = {
  mediaType: "application/json",
  size: streamedJson.byteLength,
  sha256: null,
  async *stream() {
    for (const chunk of streamedJsonChunks) yield chunk;
  },
  async readJson(maxBytes) {
    throw new RemoteError("Artifact exceeds the JSON read limit", {
      service: "platform",
      code: "REMOTE_ARTIFACT_TOO_LARGE",
      status: null,
      retryable: false,
      retryAfterMs: null,
      details: { maxBytes, size: streamedJson.byteLength },
    });
  },
};

function getFirmwareFile(
  input: FirmwareFileMetadataRequest,
  ctx?: RemoteCallContext,
): Promise<Record<string, Json>>;
function getFirmwareFile(
  input: FirmwareFileByteRequest,
  ctx?: RemoteCallContext,
): Promise<RemoteArtifact>;
async function getFirmwareFile(
  input: FirmwareFileRequest,
  _ctx?: RemoteCallContext,
): Promise<Record<string, Json> | RemoteArtifact> {
  return input.mode === "meta" ? {} : artifact;
}

const asEntity: AsEntity = {
  id: "entity-1",
  projectId: "project-1",
  kind: "threat",
  reviewVersion: "9007199254740993",
  reviewStatus: "pending",
  humanEdited: false,
  fields: {},
};

const asWriteResult: AsWriteResult = {
  success: true,
  entity: asEntity,
  reviewStatusSet: false,
  reviewStatusReason: "Route does not accept review_status",
};

const forgeSnapshot: ForgeJobSnapshot = {
  jobId: "job-1",
  status: "RUNNING",
  tool: "pen_test_run",
  recipe: null,
  scope: {},
  environment: {},
  runId: null,
  elapsedSeconds: 0,
  logTail: [],
  events: [],
  eventCount: 0,
  result: null,
  error: null,
};

const platformFake = {
  async health() {
    return { configured: true, reachable: true, detail: null };
  },
  listProjects() {
    return emptyPages<Record<string, Json>>();
  },
  listVersions() {
    return emptyPages<Record<string, Json>>();
  },
  getFindings() {
    return emptyPages<Record<string, Json>>();
  },
  async getFindingDetail() {
    return {};
  },
  getFindingActivity() {
    return emptyPages<Record<string, Json>>();
  },
  listFindingComments() {
    return emptyPages<Record<string, Json>>();
  },
  async getFindingsSummary() {
    return {};
  },
  async setVexStatus() {
    return {};
  },
  async batchSetVexStatus(input) {
    return {
      status: "success",
      summary: {
        total: input.findings.length,
        succeeded: input.findings.length,
        failed: 0,
      },
      results: input.findings.map((decision) => ({
        findingId: decision.findingId,
        success: true,
        status: decision.status,
        error: null,
      })),
    };
  },
  async clearVexStatus(_input) {},
  async downloadSbom() {
    return artifact;
  },
  listComponents() {
    return emptyPages<Record<string, Json>>();
  },
  searchComponents() {
    return emptyPages<Record<string, Json>>();
  },
  async browseFirmwareFilesystem() {
    return {};
  },
  getFirmwareFile,
  async securityAssessment() {
    return null;
  },
} satisfies PlatformClient;

const assuranceStudioFake = {
  async health() {
    return { configured: true, reachable: true, detail: null };
  },
  listEntities() {
    return emptyPages<AsEntity>();
  },
  async getEntity() {
    return asEntity;
  },
  async createEntity() {
    return asWriteResult;
  },
  async updateEntity() {
    return asWriteResult;
  },
  async deleteEntity() {
    return { success: true };
  },
  listProjectSbomPackages() {
    return emptyPages<Record<string, Json>>();
  },
  listVerificationChecks() {
    return emptyPages<Record<string, Json>>();
  },
  async getVerificationCheck() {
    return { results: [] };
  },
  async runVerificationChecks() {
    return { runId: "run-1", checksQueued: 1, status: "queued" };
  },
} satisfies AssuranceStudioClient;

const forgeComputeFake = {
  async health() {
    return { configured: true, reachable: true, detail: null };
  },
  async verifyDynamic() {
    return { verdicts: [] };
  },
  async penTestRun() {
    return { jobId: "job-1" };
  },
  async getJobStatus() {
    return forgeSnapshot;
  },
  listJobs() {
    return emptyPages<ForgeJobSnapshot>();
  },
  watchJob() {
    return emptyItems<ForgeJobSnapshot>();
  },
} satisfies ForgeComputeClient;

const PLATFORM_METHOD_EVIDENCE = {
  health: "client-local configured/reachable probe",
  listProjects: "OpenAPI GET /public/v0/projects",
  listVersions: "OpenAPI GET /public/v0/projects/{projectId}/versions",
  getFindings: "OpenAPI GET /public/v0/versions/{projectVersionId}/findings",
  getFindingDetail:
    "OpenAPI GET /public/v0/findings with includeAdditionalDetails",
  getFindingActivity:
    "OpenAPI GET /public/v0/projects/{projectId}/findings/activity",
  listFindingComments: "OpenAPI GET /public/v0/findings with includeComments",
  getFindingsSummary: "endpoint-audit.md charts § get*Counts",
  setVexStatus:
    "OpenAPI PUT /public/v0/findings/{projectVersionId}/{findingId}/status",
  batchSetVexStatus:
    "OpenAPI PUT /public/v0/findings/{projectVersionId}/status/set/bulk",
  clearVexStatus:
    "OpenAPI PUT /public/v0/findings/{projectVersionId}/status/clear/bulk",
  downloadSbom: "OpenAPI GET /public/v0/sboms/{cyclonedx|spdx}/{id}",
  listComponents: "OpenAPI GET /public/v0/components",
  searchComponents: "OpenAPI GET /public/v0/components/search",
  browseFirmwareFilesystem:
    "OpenAPI GET /public/v0/projects/versions/{id}/filesystem/{tree|overview}",
  getFirmwareFile:
    "OpenAPI GET /public/v0/projects/versions/{id}/filesystem/{content|file}",
  securityAssessment:
    "OpenAPI /public/v0/projects/versions/{id}/security-assessment/*",
} satisfies Record<keyof PlatformClient, string>;

const ASSURANCE_STUDIO_METHOD_EVIDENCE = {
  health: "client-local configured/reachable probe",
  listEntities:
    "AS OpenAPI plus assurance-studio-api-gaps.md §2 handler-backed CRUD matrix",
  getEntity:
    "AS OpenAPI plus assurance-studio-api-gaps.md §2 handler-backed item routes",
  createEntity:
    "AS OpenAPI collection POSTs; gaps §2 marks attack-path POST as a stub",
  updateEntity:
    "AS OpenAPI plus assurance-studio-api-gaps.md §2 item PATCH routes",
  deleteEntity:
    "assurance-studio-api-gaps.md §2 shared delete policy and item routes",
  listProjectSbomPackages:
    "assurance-studio-api-gaps.md §6 handler-backed GET /api/projects/{id}/sbom",
  listVerificationChecks:
    "AS OpenAPI GET /api/projects/{projectId}/verification/checks",
  getVerificationCheck:
    "AS OpenAPI GET /api/projects/{projectId}/verification/checks/{checkId} with results",
  runVerificationChecks:
    "AS OpenAPI POST /api/projects/{projectId}/verification/run",
} satisfies Record<keyof AssuranceStudioClient, string>;

const FORGE_COMPUTE_METHOD_EVIDENCE = {
  health: "client-local configured/reachable probe",
  verifyDynamic: "compute manifest verify_dynamic",
  penTestRun: "compute manifest pen_test_run",
  getJobStatus: "compute manifest get_job_status",
  listJobs: "compute manifest list_jobs",
  watchJob: "compute manifest derived polling over get_job_status",
} satisfies Record<keyof ForgeComputeClient, string>;

const PLATFORM_METHOD_KEYS = [
  "health",
  "listProjects",
  "listVersions",
  "getFindings",
  "getFindingDetail",
  "getFindingActivity",
  "listFindingComments",
  "getFindingsSummary",
  "setVexStatus",
  "batchSetVexStatus",
  "clearVexStatus",
  "downloadSbom",
  "listComponents",
  "searchComponents",
  "browseFirmwareFilesystem",
  "getFirmwareFile",
  "securityAssessment",
] as const satisfies readonly (keyof PlatformClient)[];

const ASSURANCE_STUDIO_METHOD_KEYS = [
  "health",
  "listEntities",
  "getEntity",
  "createEntity",
  "updateEntity",
  "deleteEntity",
  "listProjectSbomPackages",
  "listVerificationChecks",
  "getVerificationCheck",
  "runVerificationChecks",
] as const satisfies readonly (keyof AssuranceStudioClient)[];

const FORGE_COMPUTE_METHOD_KEYS = [
  "health",
  "verifyDynamic",
  "penTestRun",
  "getJobStatus",
  "listJobs",
  "watchJob",
] as const satisfies readonly (keyof ForgeComputeClient)[];

type RawForgeJobStatus = ForgeJobStatus | "CANCELLED";

function normalizeRawForgeStatus(status: RawForgeJobStatus): {
  status: ForgeJobStatus;
  error: ForgeJobError | null;
} {
  if (status === "CANCELLED") {
    return {
      status: "FAILED",
      error: { code: "FORGE_JOB_CANCELLED", message: "Forge cancelled job" },
    };
  }
  return { status, error: null };
}

describe("remote-service-contract-freeze", () => {
  it("minimal fakes satisfy all clients and the nullable aggregate", async () => {
    const withoutForge: RemoteServices = {
      platform: platformFake,
      assuranceStudio: assuranceStudioFake,
      forgeCompute: null,
    };
    const withForge: RemoteServices = {
      platform: platformFake,
      assuranceStudio: assuranceStudioFake,
      forgeCompute: forgeComputeFake,
    };

    await expect(withoutForge.platform.health()).resolves.toMatchObject({
      reachable: true,
    });
    await expect(withForge.forgeCompute?.health()).resolves.toMatchObject({
      configured: true,
    });
  });

  it("preserves typed, secret-safe remote error metadata", () => {
    const error = new RemoteError("Rate limited", {
      service: "platform",
      code: "RATE_LIMITED",
      status: 429,
      retryable: true,
      retryAfterMs: 2_500,
      details: { operation: "getFindings" },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: "RemoteError",
      service: "platform",
      code: "RATE_LIMITED",
      status: 429,
      retryable: true,
      retryAfterMs: 2_500,
      details: { operation: "getFindings" },
    });
    expect(Object.keys(error)).not.toContain("headers");
    expect(Object.keys(error)).not.toContain("token");
  });

  it("VEX vocabularies match the vendored v0.3.0 reference verbatim", () => {
    expect(VEX_STATUSES).toEqual([
      "EXPLOITABLE",
      "IN_TRIAGE",
      "NOT_AFFECTED",
      "FALSE_POSITIVE",
      "RESOLVED",
      "RESOLVED_WITH_PEDIGREE",
    ]);
    expect(VEX_RESPONSES).toEqual([
      "CAN_NOT_FIX",
      "WILL_NOT_FIX",
      "UPDATE",
      "ROLLBACK",
      "WORKAROUND_AVAILABLE",
    ]);
    expect(VEX_JUSTIFICATIONS).toEqual([
      "CODE_NOT_PRESENT",
      "CODE_NOT_REACHABLE",
      "REQUIRES_CONFIGURATION",
      "REQUIRES_DEPENDENCY",
      "REQUIRES_ENVIRONMENT",
      "PROTECTED_BY_COMPILER",
      "PROTECTED_AT_RUNTIME",
      "PROTECTED_AT_PERIMETER",
      "PROTECTED_BY_MITIGATING_CONTROL",
    ]);
    expect(VEX_STATUSES).toHaveLength(6);
    expect(VEX_RESPONSES).toHaveLength(5);
    expect(VEX_JUSTIFICATIONS).toHaveLength(9);
    expect(VEX_RESUMABLE_CHUNK_SIZE).toBe(500);
    expect(VEX_PLATFORM_MAX_BATCH_SIZE).toBe(5_000);
  });

  it("bulk VEX preserves request order and clear has no invented body", async () => {
    const decisions = [
      { findingId: "finding-1", status: "EXPLOITABLE" },
      {
        findingId: "finding-2",
        status: "NOT_AFFECTED",
        justification: "CODE_NOT_REACHABLE",
      },
    ] as const;

    const result = await platformFake.batchSetVexStatus({
      projectVersionId: "version-1",
      findings: [...decisions],
    });
    const clearResult = await platformFake.clearVexStatus({
      projectVersionId: "version-1",
      findingIds: decisions.map((decision) => decision.findingId),
    });

    expect(result.results.map((item) => item.findingId)).toEqual([
      "finding-1",
      "finding-2",
    ]);
    expect(clearResult).toBeUndefined();
  });

  it("artifact is bytes rather than a path and oversize JSON is typed", async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of artifact.stream()) chunks.push(chunk);

    expect(chunks).toHaveLength(2);
    expect(chunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(
      streamedJson.byteLength,
    );
    await expect(artifact.readJson(2)).rejects.toMatchObject({
      name: "RemoteError",
      code: "REMOTE_ARTIFACT_TOO_LARGE",
      retryable: false,
    });
    expect(FIRMWARE_RANGE_MAX_BYTES).toBe(131_072);
    expect(Object.keys(artifact)).not.toContain("filePath");
    expect(Object.keys(artifact)).not.toContain("savedTo");
  });

  it("raw cancelled Forge jobs normalize to typed failure", () => {
    const normalized = normalizeRawForgeStatus("CANCELLED");
    const snapshot: ForgeJobSnapshot = {
      ...forgeSnapshot,
      status: normalized.status,
      error: normalized.error,
    };

    expect(FORGE_JOB_STATUSES).toEqual([
      "RUNNING",
      "COMPLETED",
      "FAILED",
      "TIMEOUT",
    ]);
    expect(FORGE_JOB_TERMINAL_STATUSES).toEqual([
      "COMPLETED",
      "FAILED",
      "TIMEOUT",
    ]);
    expect(snapshot.status).toBe("FAILED");
    expect(snapshot.error?.code).toBe("FORGE_JOB_CANCELLED");
    expect(snapshot.status).not.toBe("COMPLETED");
    expect(FORGE_COMPUTE_TOOLS).toEqual(["verify_dynamic", "pen_test_run"]);
  });

  it("all callable methods have vendored authority and no raw escape hatch", () => {
    expect(Object.keys(PLATFORM_METHOD_EVIDENCE)).toEqual([
      ...PLATFORM_METHOD_KEYS,
    ]);
    expect(Object.keys(ASSURANCE_STUDIO_METHOD_EVIDENCE)).toEqual([
      ...ASSURANCE_STUDIO_METHOD_KEYS,
    ]);
    expect(Object.keys(FORGE_COMPUTE_METHOD_EVIDENCE)).toEqual([
      ...FORGE_COMPUTE_METHOD_KEYS,
    ]);

    const allMethodKeys = [
      ...PLATFORM_METHOD_KEYS,
      ...ASSURANCE_STUDIO_METHOD_KEYS,
      ...FORGE_COMPUTE_METHOD_KEYS,
    ];
    expect(allMethodKeys).not.toContain("asRawApi");
    expect(allMethodKeys).not.toContain("fetch");
    expect(allMethodKeys).not.toContain("request");
    expect(allMethodKeys).not.toContain("invokeTool");
    expect(allMethodKeys).not.toContain("prepareFirmwareRoot");
    expect(allMethodKeys).not.toContain("getTaraState");
    expect(allMethodKeys).not.toContain("createTaraCheckpoint");
    expect(allMethodKeys).not.toContain("createFindingComment");
    expect(allMethodKeys).not.toContain("updateFindingComment");
    expect(allMethodKeys).not.toContain("deleteFindingComment");
    expect(SECURITY_ASSESSMENT_TOOLS).toHaveLength(10);
  });

  it("vendored authorities retain the exact reviewed operation evidence", () => {
    const platformOpenApi = readFileSync(
      resolve(apiReferenceRoot, "finite-state-api-v0.3.0.openapi.yaml"),
      "utf8",
    );
    const asOpenApi = readFileSync(
      resolve(apiReferenceRoot, "assurance-studio-openapi-2026-05-12.json"),
      "utf8",
    );
    const asGaps = readFileSync(
      resolve(apiReferenceRoot, "assurance-studio-api-gaps.md"),
      "utf8",
    );
    const forgeManifest = readFileSync(
      resolve(apiReferenceRoot, "forge-compute-manifest-5083a9d7.json"),
      "utf8",
    );

    expect(platformOpenApi).toContain("bulkSetFindingStatusV0");
    expect(platformOpenApi).toContain("bulkClearFindingStatusV0");
    expect(platformOpenApi).toContain("getFilesystemContent");
    expect(asOpenApi).toContain("List verification checks");
    expect(asOpenApi).toContain("Historical results");
    expect(asOpenApi).toContain("Run all verification checks");
    expect(asGaps).toContain("AttackPath item");
    expect(asGaps).toContain("GET /api/projects/{id}/sbom");
    expect(forgeManifest).toContain('"mcpTool": "verify_dynamic"');
    expect(forgeManifest).toContain('"mcpTool": "pen_test_run"');
    expect(forgeManifest).toContain('"mcpTool": "get_job_status"');
    expect(forgeManifest).toContain('"mcpTool": "list_jobs"');
    expect(forgeManifest).toContain('"state": "non-freezeable"');
  });
});
