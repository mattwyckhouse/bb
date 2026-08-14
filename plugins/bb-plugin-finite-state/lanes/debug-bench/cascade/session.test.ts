import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../../lib/store/schema.js";
import { listBenchDevelopmentRuns } from "../probes/runs.js";
import {
  addCascadeHypothesis,
  createCascadeSession,
  finishCascadeSession,
  listCascadeSessions,
  recordCascadeStep,
  replayCascadeSession,
  type CascadeSessionDeps,
} from "./session.js";
import type { Hypothesis, TierVerdict } from "./types.js";

const databases: Database.Database[] = [];

function database(trace: string[] = []): Database.Database {
  const db = new Database(":memory:", {
    verbose: (sql) => {
      if (typeof sql === "string") trace.push(sql);
    },
  });
  databases.push(db);
  db.transaction(() => {
    for (const statement of MIGRATIONS) db.exec(statement);
  })();
  trace.splice(0);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const h0: Hypothesis = {
  id: "hyp-0",
  text: "boot calls init",
  class: "logic",
  likelihood: 0.8,
  easeOfVerification: 0.9,
};
const h1: Hypothesis = {
  id: "hyp-1",
  text: "clock timing is wrong",
  class: "timing",
  likelihood: 0.4,
  easeOfVerification: 0.3,
};

function verdict(
  hypothesisId: string,
  tier: TierVerdict["tier"],
  outcome: TierVerdict["outcome"],
): TierVerdict {
  return {
    tier,
    hypothesisId,
    outcome,
    forcedEscalation: false,
    evidence: [{ kind: "log", path: `.fs-bench/${tier}.log` }],
    producedBy: { command: [tier, "run"], inputs: { fixture: "true" } },
  };
}

function sessionDeps(db: Database.Database): {
  deps: CascadeSessionDeps;
  hints: Array<{ runId: string }>;
} {
  const hints: Array<{ runId: string }> = [];
  let tick = 0;
  return {
    deps: {
      db,
      now: () => new Date(Date.UTC(2026, 7, 14, 0, 0, tick++)),
      publish(channel, payload) {
        expect(channel).toBe("probe:changed");
        hints.push(payload);
      },
    },
    hints,
  };
}

describe("cascade sessions", () => {
  it("persists ordered hypotheses and tier decisions and replays the diagnosis", () => {
    const db = database();
    const { deps, hints } = sessionDeps(db);
    const created = createCascadeSession(deps, {
      sessionId: "session-1",
      projectId: "project-1",
      projectVersionId: "pv-1",
      hypotheses: [h0],
    });
    addCascadeHypothesis(deps, created, h1);
    recordCascadeStep(deps, created, verdict(h0.id, "d0", "inconclusive"));
    recordCascadeStep(deps, created, verdict(h0.id, "d1", "refuted"));
    finishCascadeSession(deps, created, {
      summary: "The init path is not the cause.",
      outcome: "refuted",
      evidence: [{ kind: "log", path: ".fs-bench/d1.log" }],
    });

    const replayed = replayCascadeSession(db, created);
    expect(replayed.hypotheses.map((item) => item.id)).toEqual([
      "hyp-0",
      "hyp-1",
    ]);
    expect(
      replayed.steps.map((step) => [step.sequence, step.verdict.tier]),
    ).toEqual([
      [0, "d0"],
      [1, "d1"],
    ]);
    expect(replayed.diagnosis).toEqual(
      expect.objectContaining({
        outcome: "refuted",
        summary: "The init path is not the cause.",
      }),
    );
    expect(replayed.finishedAt).not.toBeNull();
    expect(hints).toHaveLength(5);
  });

  it("pages sessions and exposes their probe link through the registered runs repository", () => {
    const db = database();
    const { deps } = sessionDeps(db);
    const first = createCascadeSession(deps, {
      sessionId: "session-a",
      projectId: "project-1",
      projectVersionId: "pv-1",
      hypotheses: [h0],
    });
    createCascadeSession(deps, {
      sessionId: "session-b",
      projectId: "project-1",
      projectVersionId: "pv-1",
      hypotheses: [h1],
    });
    const pageOne = listCascadeSessions(db, {
      projectId: "project-1",
      projectVersionId: "pv-1",
      pageSize: 1,
      cursor: null,
    });
    expect(pageOne).toMatchObject({
      total: 2,
      items: [{ sessionId: "session-b" }],
    });
    expect(pageOne.cursor).not.toBeNull();
    expect(
      listCascadeSessions(db, {
        projectId: "project-1",
        projectVersionId: "pv-1",
        pageSize: 1,
        cursor: pageOne.cursor,
      }).items.map((item) => item.sessionId),
    ).toEqual(["session-a"]);

    const registeredRows = listBenchDevelopmentRuns(db, {
      projectId: "project-1",
      projectVersionId: "pv-1",
      pageSize: 10,
      cursor: null,
      kinds: ["probe"],
    });
    expect(registeredRows.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: first.probeRunId, kind: "probe" }),
      ]),
    );
  });

  it("derives persisted decisions from the rule table and cannot store an illegal emulated confirm", () => {
    const db = database();
    const { deps } = sessionDeps(db);
    const created = createCascadeSession(deps, {
      sessionId: "session-physical",
      projectId: "project-1",
      projectVersionId: "pv-1",
      hypotheses: [h1],
    });
    const recorded = recordCascadeStep(
      deps,
      created,
      verdict(h1.id, "d1", "confirmed"),
    );
    expect(recorded.steps[0]).toMatchObject({
      verdict: { outcome: "inconclusive", forcedEscalation: true },
      decision: {
        action: "escalate",
        toTier: "d3",
        because: "class_requires_physical",
      },
    });
  });

  it("stores only diagnostic probe rows and never writes an evidence table", async () => {
    const trace: string[] = [];
    const db = database(trace);
    const { deps } = sessionDeps(db);
    const created = createCascadeSession(deps, {
      sessionId: "session-boundary",
      projectId: "project-1",
      projectVersionId: "pv-1",
      hypotheses: [h0],
    });
    finishCascadeSession(deps, created, {
      summary: "Diagnostic only",
      outcome: "confirmed",
      evidence: [{ kind: "trace", path: ".fs-bench/trace.csv" }],
    });

    const forbiddenTables = [
      "verification" + "_results",
      "attest" + "ations",
      "verification" + "_matrix",
    ];
    expect(
      trace.some((sql) =>
        forbiddenTables.some((table) =>
          new RegExp(
            `(?:insert\\s+into|update|delete\\s+from)\\s+${table}`,
            "iu",
          ).test(sql),
        ),
      ),
    ).toBe(false);

    const directory = dirname(fileURLToPath(import.meta.url));
    const implementationFiles = [
      "types.ts",
      "d0-static.ts",
      "d1-rehosted.ts",
      "d2-renode.ts",
      "escalation.ts",
      "session.ts",
    ];
    const source = (
      await Promise.all(
        implementationFiles.map(
          async (file) => await readFile(join(directory, file), "utf8"),
        ),
      )
    ).join("\n");
    expect(source).not.toMatch(
      /lanes\/(?:bench\/store|product-security\/verifications)/u,
    );
    expect(source).not.toMatch(/\b(?:attestations|verification_results)\b/u);
  });
});
