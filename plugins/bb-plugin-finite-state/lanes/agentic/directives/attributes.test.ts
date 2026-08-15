import { describe, expect, it } from "vitest";
import { findingStableKey } from "../../../lib/sync/registry.js";
import { DIRECTIVE_IDS } from "../../../lib/agentic/registry.js";
import {
  assertFindingRouteUsesEncoder,
  directiveSchemas,
  encodeFindingDirectiveKey,
  findingDirectiveSubPath,
  MAX_BOUNDED_ID_LENGTH,
  openValidatedWorkspaceFile,
  parseDirectiveAttributes,
  PR1_DIRECTIVE_IDS,
  PR2_DIRECTIVE_IDS,
  validateWorkspaceRelativePath,
} from "./attributes.js";

describe("directiveSchemas", () => {
  it("defines exactly the canonical twelve directive ids", () => {
    expect(Object.keys(directiveSchemas).sort()).toEqual(
      [...DIRECTIVE_IDS].sort(),
    );
    expect(new Set([...PR1_DIRECTIVE_IDS, ...PR2_DIRECTIVE_IDS])).toEqual(
      new Set(DIRECTIVE_IDS),
    );
  });

  it.each([
    ["fs-plan", { id: "01KPLAN0000000000000000001" }],
    ["fs-finding", { id: "fs1.finding.purl.cve.purlseg" }],
    ["fs-triage-summary", { id: "tr-1", version: "v2.4" }],
    ["fs-threat", { id: "THREAT-22" }],
    [
      "fs-canvas",
      { focus: "COMP-httpd", highlight: "THREAT-22", height: "420" },
    ],
    ["fs-req", { id: "REQ-118" }],
    ["fs-matrix", { filter: "status:failed" }],
    ["fs-component", { purl: "pkg:generic/gateway@1" }],
    ["fs-hbom-summary", {}],
    ["fs-bench", { id: "run-1" }],
    ["fs-verdict", { id: "pv-1" }],
    ["fs-doc", { id: "doc-1" }],
  ] as const)("accepts a valid %s fixture", (id, attrs) => {
    const parsed = parseDirectiveAttributes(id, attrs);
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["fs-plan", { id: "" }],
    ["fs-finding", { id: "a", extra: "x" }],
    ["fs-triage-summary", { run: "old" }],
    ["fs-threat", { id: "../escape" }],
    ["fs-canvas", { height: "100" }],
    ["fs-req", { id: "REQ 118" }],
    ["fs-matrix", { filter: "x".repeat(MAX_BOUNDED_ID_LENGTH) }],
    ["fs-component", { purl: "a", part: "b" }],
    ["fs-hbom-summary", { id: "not-allowed" }],
    ["fs-bench", {}],
    ["fs-verdict", { id: "x".repeat(MAX_BOUNDED_ID_LENGTH + 1) }],
    ["fs-doc", { id: "doc\u0000" }],
  ] as const)("rejects a malformed %s fixture", (id, attrs) => {
    const parsed = parseDirectiveAttributes(
      id,
      attrs as Readonly<Record<string, string>>,
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects extra attributes and oversized values", () => {
    expect(
      parseDirectiveAttributes("fs-req", {
        id: "REQ-1",
        surprise: "no",
      }).ok,
    ).toBe(false);
    expect(
      parseDirectiveAttributes("fs-bench", {
        id: "r".repeat(MAX_BOUNDED_ID_LENGTH + 1),
      }).ok,
    ).toBe(false);
  });

  it("parses fs-finding cve+purl form through the shared encoder", () => {
    const parsed = parseDirectiveAttributes("fs-finding", {
      cve: "CVE-2026-0039",
      purl: "pkg:generic/gateway@1.0.0",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const encoded = encodeFindingDirectiveKey(parsed.value);
    expect(encoded.startsWith("fs1.")).toBe(true);
    expect(encoded).toBe(
      findingStableKey(
        {
          cve: "CVE-2026-0039",
          purl: "pkg:generic/gateway@1.0.0",
          name: "component",
        },
        "purl",
      ),
    );
    expect(findingDirectiveSubPath(encoded)).toBe(`f/${encoded}`);
    expect(findingDirectiveSubPath(encoded)).not.toContain("|");
  });

  it("raw stable key cannot escape route encoder", () => {
    const hostile = "proj|pkg:generic/x@1|CVE-2026-1";
    expect(() => assertFindingRouteUsesEncoder(hostile)).toThrow(
      /raw stable key cannot escape route encoder/u,
    );
    expect(findingDirectiveSubPath("fs1.opaque")).toBe("f/fs1.opaque");
  });

  it("validates workspace-relative paths before openWorkspaceFile", () => {
    expect(validateWorkspaceRelativePath("product-security/req.yaml")).toBe(
      "product-security/req.yaml",
    );
    expect(validateWorkspaceRelativePath("/etc/passwd")).toBeNull();
    expect(validateWorkspaceRelativePath("../secrets")).toBeNull();
    expect(validateWorkspaceRelativePath("a/./b")).toBeNull();

    const opened: string[] = [];
    expect(
      openValidatedWorkspaceFile((path) => {
        opened.push(path);
        return true;
      }, "../escape"),
    ).toBe(false);
    expect(opened).toEqual([]);
    expect(
      openValidatedWorkspaceFile((path) => {
        opened.push(path);
        return true;
      }, "docs/note.md"),
    ).toBe(true);
    expect(opened).toEqual(["docs/note.md"]);
  });
});
