import type {
  AsEntity,
  AssuranceStudioClient,
  ForgeComputeClient,
  ForgeJobStatus,
  ForgeJobTerminalStatus,
  Json,
  PlatformClient,
  RemoteArtifact,
  RemoteServices,
  TaraFence,
  VexStatus,
} from "./types.js";

declare const platform: PlatformClient;
declare const assuranceStudio: AssuranceStudioClient;
declare const forgeCompute: ForgeComputeClient;
declare const artifact: RemoteArtifact;

const nullableAggregate: RemoteServices = {
  platform,
  assuranceStudio,
  forgeCompute: null,
};

const configuredAggregate: RemoteServices = {
  platform,
  assuranceStudio,
  forgeCompute,
};

const platformCannotBeForge: RemoteServices = {
  platform,
  assuranceStudio,
  // @ts-expect-error Platform methods cannot substitute for Forge compute.
  forgeCompute: platform,
};

const assuranceStudioCannotBeForge: RemoteServices = {
  platform,
  assuranceStudio,
  // @ts-expect-error Assurance Studio methods cannot substitute for Forge compute.
  forgeCompute: assuranceStudio,
};

void nullableAggregate;
void configuredAggregate;
void platformCannotBeForge;
void assuranceStudioCannotBeForge;

void assuranceStudio.createEntity("threat", {
  projectId: "project-1",
  fields: {},
});

// @ts-expect-error Attack paths have a handler stub, not a create route.
void assuranceStudio.createEntity("attack-path", {
  projectId: "project-1",
  fields: {},
});

// @ts-expect-error Every Assurance Studio entity operation requires project scope.
void assuranceStudio.getEntity("threat", { id: "threat-1" });

// @ts-expect-error Project SBOM package reads have no ambient project.
void assuranceStudio.listProjectSbomPackages({ limit: 20 });

// @ts-expect-error Verification operations have no ambient project.
void assuranceStudio.getVerificationCheck({ checkId: "check-1" });

const validFence: TaraFence = { expectedHeadVersionId: "head-1" };
// @ts-expect-error A working hash alone is not a TARA fence.
const missingHeadFence: TaraFence = { expectedWorkingHash: "hash-1" };

const largeReviewVersion: AsEntity = {
  id: "threat-1",
  projectId: "project-1",
  kind: "threat",
  reviewVersion: "9007199254740993",
  reviewStatus: "pending",
  humanEdited: true,
  fields: {},
};

const lossyReviewVersion: AsEntity = {
  id: "threat-1",
  projectId: "project-1",
  kind: "threat",
  // @ts-expect-error Review versions are decimal strings, never lossy numbers.
  reviewVersion: 9_007_199_254_740_993,
  reviewStatus: "pending",
  humanEdited: true,
  fields: {},
};

void validFence;
void missingHeadFence;
void largeReviewVersion;
void lossyReviewVersion;

const running: ForgeJobStatus = "RUNNING";
const terminal: ForgeJobTerminalStatus = "COMPLETED";
// @ts-expect-error Raw CANCELLED is normalized to FAILED.
const cancelled: ForgeJobStatus = "CANCELLED";
// @ts-expect-error SUCCEEDED is not a Forge registry state.
const succeeded: ForgeJobStatus = "SUCCEEDED";
// @ts-expect-error RUNNING is the sole nonterminal state.
const runningTerminal: ForgeJobTerminalStatus = "RUNNING";

void running;
void terminal;
void cancelled;
void succeeded;
void runningTerminal;

const validVex: VexStatus = "NOT_AFFECTED";
// @ts-expect-error VEX uses the six exact upstream status literals.
const invalidVex: VexStatus = "AFFECTED";
void validVex;
void invalidVex;

// @ts-expect-error Bulk clear resolves void after 204, not an invented envelope.
const inventedClearEnvelope: Promise<{ success: true }> =
  platform.clearVexStatus({
    projectVersionId: "version-1",
    findingIds: ["finding-1"],
  });
void inventedClearEnvelope;

void platform.securityAssessment({
  tool: "stp_callgraph",
  projectVersionId: "version-1",
});

const firmwareMetadata: Promise<Record<string, Json>> =
  platform.getFirmwareFile({
    projectVersionId: "version-1",
    fileHash: "hash-1",
    mode: "meta",
  });
const firmwareBytes: Promise<RemoteArtifact> = platform.getFirmwareFile({
  projectVersionId: "version-1",
  fileHash: "hash-1",
  mode: "full",
});
void firmwareMetadata;
void firmwareBytes;

void forgeCompute.listJobs({ tool: "verify_dynamic" });
void forgeCompute.listJobs({
  // @ts-expect-error Job filters cannot name an unreviewed Forge/MCP tool.
  tool: "arbitrary_tool",
});

void platform.securityAssessment({
  // @ts-expect-error An eleventh or arbitrary STP relay cannot be represented.
  tool: "stp_arbitrary",
  projectVersionId: "version-1",
});

void forgeCompute.penTestRun({
  cveId: "CVE-2026-0001",
  componentId: "component-1",
  projectId: "project-1",
  projectVersionId: "version-1",
  deploymentContext: {
    productType: "gateway",
    networkExposure: "wan",
    regulatory: "CRA",
    deploymentNotes: "field",
    rootComponentName: "rootfs",
    rootComponentType: "firmware",
  },
});

void forgeCompute.penTestRun({
  cveId: "CVE-2026-0001",
  componentId: "component-1",
  projectId: "project-1",
  projectVersionId: "version-1",
  // @ts-expect-error Caller-visible local paths are forbidden at this boundary.
  firmwarePath: "forbidden-local-rootfs",
});

// @ts-expect-error A-000 removed the unverified firmware-root compute member.
void forgeCompute.prepareFirmwareRoot({
  projectVersionId: "version-1",
  rootPath: "forbidden-local-rootfs",
  expectedDigest: "digest",
});

// @ts-expect-error No verified public AS route exists for TARA state reads.
void assuranceStudio.getTaraState("project-1");

// @ts-expect-error No verified public AS route exists for checkpoint creation.
void assuranceStudio.createTaraCheckpoint({
  projectId: "project-1",
  expected: validFence,
  message: "checkpoint",
});

// @ts-expect-error Finding comment mutation is absent from Platform v0.3.0.
void platform.createFindingComment({
  projectVersionId: "version-1",
  findingId: "finding-1",
  text: "comment",
});

// @ts-expect-error The closed clients expose no generic request seam.
void platform.request("GET", "/anything");
// @ts-expect-error The closed clients expose no arbitrary AS route seam.
void assuranceStudio.asRawApi("GET", "/anything");
// @ts-expect-error The compute client exposes named operations, not MCP invocation.
void forgeCompute.invokeTool("anything", {});
// @ts-expect-error Artifacts expose bytes and JSON, never a saved local path.
void artifact.savedTo;
