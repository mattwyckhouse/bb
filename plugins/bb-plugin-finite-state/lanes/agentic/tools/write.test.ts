import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createPluginContext } from "../../../lib/context.js";
import {
  REQUIREMENT_WRITER_SERVICE,
  TRIAGE_WRITER_SERVICE,
  registerWriteTools,
  type LocalWrite,
  type RequirementWriter,
  type TriageWriter,
} from "./write.js";
import {
  hbomExtractSchema,
  requirementWriteSchema,
  triageApplyPolicySchema,
  triageSetSchema,
} from "./write-schemas.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];
afterEach(async () =>
  Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose())),
);

function parseTool(result: unknown): unknown {
  if (typeof result === "string") return JSON.parse(result);
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("unexpected tool result shape");
  }
  const content = Reflect.get(result, "content");
  if (!Array.isArray(content)) throw new Error("missing tool content");
  const first = content[0];
  const text =
    typeof first === "object" &&
    first !== null &&
    typeof Reflect.get(first, "text") === "string"
      ? Reflect.get(first, "text")
      : null;
  if (typeof text !== "string") throw new Error("missing tool JSON");
  return JSON.parse(text);
}

const noopWrite: LocalWrite = {
  path: ".fs/triage/project/busybox.yaml",
  op: "noop",
  diffSummary: [],
  omittedDiffs: 0,
  contentHash: "a".repeat(64),
};

const validRequirementYaml = {
  schema: "fs-requirement/v1",
  id: "REQ-ok",
  req_type: "security",
  priority: "P1",
  status: "draft",
  ears: {
    pattern: "ubiquitous",
    text: "The gateway SHALL reject unsigned firmware",
    parts: { system: "gateway", response: "reject unsigned firmware" },
  },
  source_description: "Protect the update trust boundary.",
  mitigations: [],
  controls: [],
  standards: [],
  verification: [],
};

describe("write tool unit behaviors", () => {
  it("triage identical tuple returns noop", async () => {
    const host = createFakePluginHost({
      pluginId: `fs-write-noop-${crypto.randomUUID()}`,
    });
    hosts.push(host);
    const ctx = createPluginContext(host.bb);
    const set = vi.fn(async () => noopWrite);
    ctx.service<TriageWriter>(TRIAGE_WRITER_SERVICE, () => ({
      set,
      applyPolicy: vi.fn(),
    }));
    registerWriteTools(host.bb, ctx);
    const result = parseTool(
      await host.harness.behavior.callAgentTool("fs_triage_set", {
        projectVersionId: "pv-1",
        stableKey: "sk-1",
        status: "IN_TRIAGE",
        justification: null,
        response: null,
        reason: "investigating call paths",
        evidence: "scanner finding retained",
        expectedHash: "a".repeat(64),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: { op: "noop", path: ".fs/triage/project/busybox.yaml" },
    });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("CODE_NOT_REACHABLE rejects any_version at the schema boundary", () => {
    expect(
      triageSetSchema.safeParse({
        projectVersionId: "pv-1",
        stableKey: "sk-1",
        status: "NOT_AFFECTED",
        justification: "CODE_NOT_REACHABLE",
        response: null,
        reason: "dead call path proved by the attached trace",
        pin: "any_version",
        evidence: "call graph shows no reachable use",
      }).success,
    ).toBe(false);
  });

  it("policy schema refuses overwrite_existing", () => {
    expect(
      triageApplyPolicySchema.safeParse({ projectVersionId: "pv-1" }).success,
    ).toBe(true);
    expect(
      triageApplyPolicySchema.safeParse({
        projectVersionId: "pv-1",
        overwrite_existing: true,
      }).success,
    ).toBe(false);
  });

  it("requirement validation error leaves file byte-identical", async () => {
    const writes: unknown[] = [];
    const host = createFakePluginHost({
      pluginId: `fs-write-req-err-${crypto.randomUUID()}`,
      sdk: {
        projects: {
          get: () => ({
            sources: [
              { hostId: "host-1", path: "/workspace", isDefault: true },
            ],
          }),
        },
        files: {
          read: async () => {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          },
          write: async (input: unknown) => {
            writes.push(input);
            return {
              outcome: "written",
              sha256: "c".repeat(64),
              sizeBytes: 1,
            };
          },
        },
      },
    });
    hosts.push(host);
    const ctx = createPluginContext(host.bb);
    registerWriteTools(host.bb, ctx);
    const result = parseTool(
      await host.harness.behavior.callAgentTool("fs_requirement_write", {
        reqId: "REQ-bad",
        yaml: {
          ...validRequirementYaml,
          id: "REQ-bad",
          verification_status: "verified",
        },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { retryable: false },
    });
    expect(JSON.stringify(result)).toMatch(/verification_status|DERIVED/i);
    expect(writes).toHaveLength(0);
  });

  it("valid requirement passes Gates 1–2 but cannot mark human Gate 3 complete", async () => {
    const host = createFakePluginHost({
      pluginId: `fs-write-req-ok-${crypto.randomUUID()}`,
    });
    hosts.push(host);
    const ctx = createPluginContext(host.bb);
    const write = vi.fn(async () => ({
      path: "product-security/requirements/REQ-ok.yaml",
      op: "create" as const,
      diffSummary: [{ field: "id", from: null, to: "updated" }],
      omittedDiffs: 0,
      contentHash: "c".repeat(64),
      gates: {
        schema: "passed" as const,
        lint: "passed" as const,
        humanReview: "pending" as const,
      },
    }));
    ctx.service<RequirementWriter>(REQUIREMENT_WRITER_SERVICE, () => ({
      write,
    }));
    registerWriteTools(host.bb, ctx);
    const result = parseTool(
      await host.harness.behavior.callAgentTool("fs_requirement_write", {
        reqId: "REQ-ok",
        yaml: validRequirementYaml,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        gates: {
          schema: "passed",
          lint: "passed",
          humanReview: "pending",
        },
      },
    });
    const data = (result as { data: { gates: Record<string, string> } }).data;
    expect(data.gates.humanReview).toBe("pending");
    expect(data.gates.humanReview).not.toBe("complete");
  });

  it("HBOM extraction rejects accepted/provenance human input", () => {
    const base = {
      projectVersionId: "pv-1",
      documentSha256: "d".repeat(64),
      expectedHbomSha256: "e".repeat(64),
      createMissingParts: false,
      cells: [
        {
          part: { id: "part-1" },
          field: "mpn",
          value: "ABC-123",
          source_ref: {
            documentSha256: "d".repeat(64),
            locator: { kind: "pdf", page: 1 },
          },
          confidence: 0.9,
        },
      ],
    };
    expect(hbomExtractSchema.safeParse(base).success).toBe(true);
    expect(
      hbomExtractSchema.safeParse({
        ...base,
        cells: [{ ...base.cells[0], accepted: { by: "human", at: "now" } }],
      }).success,
    ).toBe(false);
    expect(
      hbomExtractSchema.safeParse({
        ...base,
        cells: [{ ...base.cells[0], provenance: "human" }],
      }).success,
    ).toBe(false);
  });

  it("requirement schema accepts object yaml only", () => {
    expect(
      requirementWriteSchema.safeParse({
        reqId: "REQ-ok",
        yaml: "schema: fs-requirement/v1\n",
      }).success,
    ).toBe(false);
  });
});
