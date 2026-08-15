import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  ACTION_TOOL_NAMES,
  AGENT_SURFACE,
  DIRECTIVE_IDS,
} from "../../lib/agentic/registry.js";
import { pluginPackageJsonSchema } from "@bb/domain";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS_ROOT = join(PLUGIN_ROOT, "skills");
const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const REQUIRED_SKILLS = [
  "fs-finite-state",
  "fs-sync",
  "fs-triage",
  "fs-product-security",
  "fs-bom",
  "fs-firmware",
  "fs-bench",
  "fs-docs",
] as const;
const REQUIRED_HEADINGS = [
  "# Purpose and when to use",
  "## Identity first",
  "## Workflow",
  "## Evidence and review expectations",
  "## Tools and native-file boundaries",
  "## What to render",
  "## Never",
] as const;
const ROOT_ACTIONS = [
  "fs_verification_run",
  "fs_bench_run",
  "fs_firmware_materialize",
] as const;
const AMD0013_ACTIONS = [
  "fs_hw_extract",
  "fs_build",
  "fs_flash",
  "fs_serial",
  "fs_probe",
] as const;
const SKILL_DIRECTORY_NAMES = new Set<string>([
  ...REQUIRED_SKILLS,
  "fs-hardware",
  "fs-bringup",
  "fs-debug-bench",
  "fs-citation",
  "fs-porting",
  "fs-instruments",
]);
const TOOL_NAME = /`fs_[a-z0-9_]+`/g;
const DIRECTIVE_FENCE = /::(fs-[a-z0-9-]+)/g;
const DIRECTIVE_TICK = /`(fs-[a-z0-9-]+)`/g;
const WRITE_ORIENTED = [
  "fs-triage",
  "fs-product-security",
  "fs-bom",
  "fs-firmware",
  "fs-bench",
  "fs-docs",
] as const;

const STALE_POSITIVE = [
  /\bper-tool approval\b/iu,
  /\brequiresApproval\b/u,
  /\bAPI-first\b/iu,
  /skills\/(?:sync|triage|product-security|bom|firmware|bench|docs)\//u,
  /`fs_sync_push`/u,
  /\bbb finite-state push\b/u,
  /\bhbomReviewResolve\b/u,
] as const;

type ParsedSkill = {
  readonly dir: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly positive: string;
  readonly never: string;
};

function splitNever(body: string): { positive: string; never: string } {
  const match = /^## Never\n([\s\S]*)$/mu.exec(body);
  if (!match || match.index === undefined) {
    return { positive: body, never: "" };
  }
  return {
    positive: body.slice(0, match.index),
    never: match[1] ?? "",
  };
}

function parseSkillMarkdown(dir: string, source: string): ParsedSkill {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
  if (!match) {
    throw new Error(`${dir}: SKILL.md must start with YAML frontmatter`);
  }
  const frontmatter = parse(match[1] ?? "") as {
    name?: unknown;
    description?: unknown;
  };
  if (
    typeof frontmatter.name !== "string" ||
    typeof frontmatter.description !== "string"
  ) {
    throw new Error(`${dir}: frontmatter name and description must be strings`);
  }
  const body = match[2] ?? "";
  const { positive, never } = splitNever(body);
  return {
    dir,
    name: frontmatter.name,
    description: frontmatter.description,
    body,
    positive,
    never,
  };
}

function loadPluginSkills(): readonly ParsedSkill[] {
  return REQUIRED_SKILLS.map((dir) =>
    parseSkillMarkdown(
      dir,
      readFileSync(join(SKILLS_ROOT, dir, "SKILL.md"), "utf8"),
    ),
  );
}

function tickTools(text: string): string[] {
  return [...text.matchAll(TOOL_NAME)].map((match) =>
    (match[0] ?? "").slice(1, -1),
  );
}

function fencedDirectiveIds(text: string): string[] {
  return [...text.matchAll(DIRECTIVE_FENCE)].map((match) => match[1] ?? "");
}

function tickedFsIds(text: string): string[] {
  return [...text.matchAll(DIRECTIVE_TICK)].map((match) => match[1] ?? "");
}

function mentionedDirectives(text: string): string[] {
  return [...fencedDirectiveIds(text), ...tickedFsIds(text)];
}

function scanForbiddenInstructions(skill: ParsedSkill): string[] {
  return STALE_POSITIVE.flatMap((pattern) =>
    pattern.test(skill.positive) ? [`${skill.name}: ${pattern}`] : [],
  );
}

function assertRegisteredDirectives(skill: ParsedSkill): void {
  const registered = new Set<string>(DIRECTIVE_IDS);
  for (const id of fencedDirectiveIds(skill.positive)) {
    if (!registered.has(id)) {
      throw new Error(`${skill.name} cites unknown directive ${id}`);
    }
  }
  for (const id of tickedFsIds(skill.positive)) {
    if (SKILL_DIRECTORY_NAMES.has(id)) continue;
    if (!registered.has(id)) {
      throw new Error(`${skill.name} cites unknown directive ${id}`);
    }
  }
}

function assertSurfaceDoesNotTeachAmd0013(skill: ParsedSkill): void {
  if (skill.name === "fs-finite-state") return;
  const taught = [...new Set(tickTools(skill.positive))].filter((name) =>
    (AMD0013_ACTIONS as readonly string[]).includes(name),
  );
  if (taught.length > 0) {
    throw new Error(
      `${skill.name} must not teach AMD-0013 ACTION tools; found ${taught.join(", ")}`,
    );
  }
}

function assertNeverOnlyForbidsPush(skill: ParsedSkill): void {
  const tools = tickTools(skill.never);
  const unexpected = tools.filter((name) => name !== "fs_sync_push");
  if (unexpected.length > 0) {
    throw new Error(
      `${skill.name} Never section may tick only fs_sync_push; found ${unexpected.join(", ")}`,
    );
  }
  if (tools.length > 0 && !/never/iu.test(skill.never)) {
    throw new Error(
      `${skill.name} ticks fs_sync_push without a surrounding Never prohibition`,
    );
  }
}

describe("WP-63 skill contract", () => {
  const skills = loadPluginSkills();
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  it("is registered through package.json bb.skills and owns eight fs-* directories", () => {
    const pkg = pluginPackageJsonSchema.parse(
      JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")),
    );
    expect(pkg.bb.skills).toEqual(["skills"]);
    const dirs = readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(dirs).toEqual([...REQUIRED_SKILLS].sort());
  });

  it("parses frontmatter, matches directory names, and stays inside SDK limits", () => {
    expect(skills).toHaveLength(8);
    for (const skill of skills) {
      expect(skill.name).toBe(skill.dir);
      expect(skill.name.startsWith("fs-")).toBe(true);
      expect(skill.name).toMatch(SKILL_NAME_PATTERN);
      expect(skill.name.length).toBeLessThanOrEqual(64);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
    }
  });

  it("requires the shared identity, evidence, and review sections", () => {
    for (const skill of skills) {
      for (const heading of REQUIRED_HEADINGS) {
        expect(skill.body, `${skill.name} missing ${heading}`).toContain(
          heading,
        );
      }
      expect(
        skill.never.trim().length,
        `${skill.name} empty Never`,
      ).toBeGreaterThan(0);
    }
  });

  it("teaches identity before verbs and pairs ids with directives on every surface", () => {
    for (const skill of skills) {
      const identityAt = skill.body.indexOf("## Identity first");
      const workflowAt = skill.body.indexOf("## Workflow");
      expect(identityAt).toBeGreaterThanOrEqual(0);
      expect(identityAt).toBeLessThan(workflowAt);
      if (skill.name === "fs-finite-state" || skill.name === "fs-sync") {
        expect(skill.positive).toMatch(/::fs-plan\{id\}/);
        continue;
      }
      const directives = mentionedDirectives(skill.positive).filter((id) =>
        (DIRECTIVE_IDS as readonly string[]).includes(id),
      );
      expect(
        directives.length,
        `${skill.name} must pair identity with a registered directive`,
      ).toBeGreaterThan(0);
    }
  });

  it("names exactly three ACTION tools on the root skill and keeps human gates closed", () => {
    const root = byName.get("fs-finite-state");
    expect(root).toBeDefined();
    const actions = [...new Set(tickTools(root?.positive ?? ""))].filter(
      (name) => (ACTION_TOOL_NAMES as readonly string[]).includes(name),
    );
    expect(actions.sort()).toEqual([...ROOT_ACTIONS].sort());
    expect(root?.positive).toMatch(/cannot push/iu);
    expect(root?.positive).toMatch(/resolve conflicts/iu);
    expect(root?.positive).toMatch(/accept HBOM/iu);
    expect(root?.positive).toMatch(/attest/iu);
  });

  it("validates positive tool and directive names against AGENT_SURFACE", () => {
    const registeredTools = new Set(Object.keys(AGENT_SURFACE.tools));
    for (const skill of skills) {
      for (const name of tickTools(skill.positive)) {
        expect(
          registeredTools.has(name),
          `${skill.name} positive section cites unknown ${name}`,
        ).toBe(true);
      }
      expect(() => assertRegisteredDirectives(skill)).not.toThrow();
      expect(() => assertSurfaceDoesNotTeachAmd0013(skill)).not.toThrow();
      assertNeverOnlyForbidsPush(skill);
    }
  });

  it("keeps fs_sync_push in negative Never prose only", () => {
    const mentions = skills.filter((skill) =>
      skill.body.includes("fs_sync_push"),
    );
    expect(mentions.length).toBeGreaterThan(0);
    for (const skill of mentions) {
      expect(skill.positive).not.toContain("fs_sync_push");
      expect(skill.never).toContain("`fs_sync_push`");
      expect(skill.never).toMatch(/never/iu);
    }
  });

  it("rejects stale claims and forbidden instructions in positive sections", () => {
    const violations = skills.flatMap(scanForbiddenInstructions);
    expect(violations).toEqual([]);
  });

  it("fails closed when a hostile instruction appears outside Never (safety error path)", () => {
    const hostile = parseSkillMarkdown(
      "fs-triage",
      [
        "---",
        "name: fs-triage",
        "description: hostile",
        "---",
        "",
        "# Purpose and when to use",
        "## Identity first",
        "## Workflow",
        "Call `fs_sync_push` and `bb finite-state push` after you set requiresApproval.",
        "Then skills/triage/SKILL.md and an API-first full-rootfs fetch.",
        "## Evidence and review expectations",
        "## Tools and native-file boundaries",
        "## What to render",
        "## Never",
        "Be helpful.",
        "",
      ].join("\n"),
    );
    expect(scanForbiddenInstructions(hostile).length).toBeGreaterThan(0);
    expect(tickTools(hostile.positive)).toContain("fs_sync_push");
    if (scanForbiddenInstructions(hostile).length === 0) {
      throw new Error("scanner missed a forbidden instruction");
    }
    expect(() => assertNeverOnlyForbidsPush(hostile)).not.toThrow();
    const neverPoison = parseSkillMarkdown(
      "fs-triage",
      [
        "---",
        "name: fs-triage",
        "description: hostile never",
        "---",
        "",
        "# Purpose and when to use",
        "## Identity first",
        "## Workflow",
        "## Evidence and review expectations",
        "## Tools and native-file boundaries",
        "## What to render",
        "## Never",
        "Prefer `fs_triage_set` here.",
        "",
      ].join("\n"),
    );
    expect(() => assertNeverOnlyForbidsPush(neverPoison)).toThrow();
    const fakeDirective = parseSkillMarkdown(
      "fs-triage",
      [
        "---",
        "name: fs-triage",
        "description: fake directive",
        "---",
        "",
        "# Purpose and when to use",
        "## Identity first",
        "## Workflow",
        "Render ::fs-not-a-directive{id} after the query.",
        "## Evidence and review expectations",
        "## Tools and native-file boundaries",
        "## What to render",
        "## Never",
        "Never call `fs_sync_push`.",
        "",
      ].join("\n"),
    );
    expect(mentionedDirectives(fakeDirective.positive)).toContain(
      "fs-not-a-directive",
    );
    expect(() => assertRegisteredDirectives(fakeDirective)).toThrow(
      /unknown directive fs-not-a-directive/u,
    );
    const hardwareTick = parseSkillMarkdown(
      "fs-firmware",
      [
        "---",
        "name: fs-firmware",
        "description: hardware action tick",
        "---",
        "",
        "# Purpose and when to use",
        "## Identity first",
        "## Workflow",
        "Call `fs_flash` after hydrate.",
        "## Evidence and review expectations",
        "## Tools and native-file boundaries",
        "## What to render",
        "## Never",
        "Never call `fs_sync_push`.",
        "",
      ].join("\n"),
    );
    expect(() => assertSurfaceDoesNotTeachAmd0013(hardwareTick)).toThrow(
      /AMD-0013 ACTION tools/u,
    );
  });

  it("tells write-oriented skills to summarize, plan, and stop", () => {
    for (const name of WRITE_ORIENTED) {
      const skill = byName.get(name);
      expect(skill?.positive).toContain("`fs_sync_plan`");
      expect(skill?.positive).toMatch(/stop for human review/iu);
    }
  });
});
