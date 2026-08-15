import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const SKILLS_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../skills",
);
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

type ParsedSkill = {
  readonly name: string;
  readonly description: string;
  readonly positive: string;
  readonly never: string;
};

type AdversarialKind = "push" | "fabricate" | "api-rootfs";

type TriggerCase = {
  readonly id: string;
  readonly query: string;
  readonly expectedSkill: string;
  readonly adversarial?: AdversarialKind;
};

type Fixture = {
  readonly harness: {
    readonly name: string;
    readonly provider: string;
    readonly model: string;
    readonly version: string;
  };
  readonly failBelow: number;
  readonly cases: readonly TriggerCase[];
};

const FIXTURE: Fixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures/trigger-cases.json",
    ),
    "utf8",
  ),
) as Fixture;

function splitNever(body: string): { positive: string; never: string } {
  const match = /^## Never\n([\s\S]*)$/mu.exec(body);
  if (!match || match.index === undefined) {
    return { positive: body, never: "" };
  }
  return { positive: body.slice(0, match.index), never: match[1] ?? "" };
}

function loadPluginSkills(): readonly ParsedSkill[] {
  return REQUIRED_SKILLS.map((dir) => {
    const source = readFileSync(join(SKILLS_ROOT, dir, "SKILL.md"), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
    if (!match) {
      throw new Error(`${dir}: missing frontmatter`);
    }
    const frontmatter = parse(match[1] ?? "") as {
      name?: unknown;
      description?: unknown;
    };
    if (
      typeof frontmatter.name !== "string" ||
      typeof frontmatter.description !== "string"
    ) {
      throw new Error(`${dir}: invalid frontmatter`);
    }
    const parts = splitNever(match[2] ?? "");
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      ...parts,
    };
  });
}

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length >= 3,
  );
}

function hasToken(haystack: Set<string>, token: string): boolean {
  if (haystack.has(token) || haystack.has(`${token}s`)) return true;
  if (token.endsWith("s") && haystack.has(token.slice(0, -1))) return true;
  return false;
}

function scoreQuery(query: string, skill: ParsedSkill): number {
  const queryTokens = tokens(query);
  const descriptionTokens = new Set(tokens(skill.description));
  const nameTokens = tokens(
    skill.name.replace(/^fs-/u, "").replaceAll("-", " "),
  );
  let score = 0;
  for (const token of queryTokens) {
    if (hasToken(descriptionTokens, token)) score += 1;
  }
  for (let index = 0; index < queryTokens.length - 1; index += 1) {
    if (
      hasToken(descriptionTokens, queryTokens[index] ?? "") &&
      hasToken(descriptionTokens, queryTokens[index + 1] ?? "")
    ) {
      score += 3;
    }
  }
  for (const token of nameTokens) {
    if (queryTokens.includes(token)) score += 2;
  }
  return score;
}

function routeQuery(
  query: string,
  skills: readonly ParsedSkill[],
): ParsedSkill {
  const ranked = [...skills]
    .map((skill) => ({ skill, score: scoreQuery(query, skill) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.skill.name.localeCompare(right.skill.name);
    });
  const winner = ranked[0];
  if (!winner) {
    throw new Error(`no skill available to route: ${query}`);
  }
  return winner.skill;
}

function adversarialOk(kind: AdversarialKind, skill: ParsedSkill): boolean {
  const never = skill.never.toLowerCase();
  if (kind === "push") {
    return never.includes("fs_sync_push") || never.includes("cannot push");
  }
  if (kind === "fabricate") {
    return never.includes("source_ref") || never.includes("fabricate");
  }
  return (
    never.includes("standalone unpack") ||
    never.includes("hydrate_all") ||
    never.includes("full rootfs")
  );
}

describe("WP-63 trigger evaluation", () => {
  const skills = loadPluginSkills();

  it("records a provider-independent fixture harness", () => {
    expect(FIXTURE.harness).toEqual({
      name: "deterministic-keyword-overlap",
      provider: "fixture",
      model: "none",
      version: "wp-63-trigger-eval-v1",
    });
    expect(FIXTURE.cases).toHaveLength(20);
    expect(
      FIXTURE.cases.filter((item) => item.adversarial).length,
    ).toBeGreaterThanOrEqual(2);
    expect(FIXTURE.failBelow).toBe(18);
  });

  it("routes at least 18/20 scripted asks to the intended skill", () => {
    const results = FIXTURE.cases.map((item) => {
      const selected = routeQuery(item.query, skills);
      return {
        id: item.id,
        expected: item.expectedSkill,
        selected: selected.name,
        ok: selected.name === item.expectedSkill,
      };
    });
    const hits = results.filter((item) => item.ok).length;
    expect(
      hits,
      `routing ${hits}/${results.length} — ${JSON.stringify(
        results.filter((item) => !item.ok),
      )} harness=${FIXTURE.harness.version}`,
    ).toBeGreaterThanOrEqual(FIXTURE.failBelow);
  });

  it("keeps adversarial asks on a refusal/review skill", () => {
    const adversarial = FIXTURE.cases.filter((item) => item.adversarial);
    for (const item of adversarial) {
      const selected = routeQuery(item.query, skills);
      expect(
        adversarialOk(item.adversarial ?? "push", selected),
        `${item.id} routed to ${selected.name} without a Never refusal`,
      ).toBe(true);
      expect(selected.positive).not.toContain("`fs_sync_push`");
      expect(selected.never).toMatch(/never/iu);
    }
  });
});
