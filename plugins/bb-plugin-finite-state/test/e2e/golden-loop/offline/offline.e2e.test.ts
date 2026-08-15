import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import plugin from "../../../../server.js";
import { GOLDEN_LOOP_BEATS } from "../scenario.js";
import {
  OfflineNetworkGuard,
  UndeclaredNetworkError,
} from "./network-guard.js";

const PLUGIN_ROOT = resolve(import.meta.dirname, "../../../..");
const DOC_ROOT = resolve(PLUGIN_ROOT, "docs/demo");
const REFERENCE_BUDGET_MS = 15 * 60 * 1_000;
const guards: OfflineNetworkGuard[] = [];

afterEach(() => {
  for (const guard of guards.splice(0)) guard.restore();
});

function installedGuard(beat: string): OfflineNetworkGuard {
  const guard = new OfflineNetworkGuard();
  guard.setBeat(beat);
  guard.install();
  guards.push(guard);
  return guard;
}

describe.sequential("Golden Loop offline gate", () => {
  it("pins the shipped sixteen-beat registry and fifteen-minute reference budget", () => {
    expect(GOLDEN_LOOP_BEATS).toHaveLength(16);
    expect(GOLDEN_LOOP_BEATS.map(({ number }) => number)).toEqual(
      Array.from({ length: 16 }, (_value, index) => index + 1),
    );
    expect(REFERENCE_BUDGET_MS).toBe(900_000);
  });

  it.each([
    ["HTTP", () => http.get("http://example.invalid/offline")],
    ["DNS", () => dns.lookup("example.invalid", () => undefined)],
    ["socket", () => net.connect({ host: "198.51.100.10", port: 443 })],
    ["TLS", () => tls.connect({ host: "example.invalid", port: 443 })],
  ])(
    "fails the originating beat immediately for an unexpected %s call",
    (_kind, call) => {
      const guard = installedGuard("beat-07");
      expect(call).toThrow(UndeclaredNetworkError);
      expect(guard.violations).toEqual([
        expect.objectContaining({ beat: "beat-07" }),
      ]);
    },
  );

  it("rejects an unexpected fetch before the request can leave the beat", async () => {
    const guard = installedGuard("beat-07-fetch");
    await expect(fetch("https://example.invalid/offline")).rejects.toThrow(
      UndeclaredNetworkError,
    );
    expect(guard.violations).toEqual([
      expect.objectContaining({ beat: "beat-07-fetch", primitive: "fetch" }),
    ]);
  });

  it("rejects an undeclared Forge MCP endpoint before transport construction", () => {
    const guard = installedGuard("beat-11-mcp");
    expect(() =>
      guard.assertMcpEndpoint("https://example.invalid/mcp"),
    ).toThrow(UndeclaredNetworkError);
    expect(guard.violations).toEqual([
      expect.objectContaining({ beat: "beat-11-mcp", primitive: "fetch" }),
    ]);
  });

  it("executes every fenced runbook command through the shipped CLI", async () => {
    const host = createFakePluginHost({ pluginId: "finite-state" });
    await plugin(host.bb);
    try {
      for (const name of [
        "GOLDEN-LOOP-RUNBOOK.md",
        "FAILURE-RECOVERY.md",
        "PREFLIGHT-CHECKLIST.md",
        "CONNECTED-REHEARSAL.md",
      ]) {
        const markdown = await readFile(resolve(DOC_ROOT, name), "utf8");
        const commands = [
          ...markdown.matchAll(/^```console\n([\s\S]*?)^```$/gmu),
        ]
          .flatMap((match) => match[1]!.split("\n"))
          .filter((line) => line.startsWith("bb finite-state "));
        expect(
          commands.length,
          `${name} has no checked CLI command`,
        ).toBeGreaterThan(0);
        for (const command of commands) {
          const argv = command.split(" ").slice(1);
          const result = await host.harness.behavior.runCli(argv, {
            projectId: "workspace-golden-loop",
            threadId: "thread-golden-loop-docs",
          });
          expect(result.stderr).not.toMatch(/unknown command|usage:/iu);
        }
      }
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});
