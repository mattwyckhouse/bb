import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createFakePluginHost,
  makeThreadResponse,
} from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";

import plugin from "../../../../server.js";
import { GOLDEN_LOOP_BEATS } from "../scenario.js";
import {
  OfflineNetworkGuard,
  UndeclaredNetworkError,
} from "./network-guard.js";

const PLUGIN_ROOT = resolve(import.meta.dirname, "../../../..");
const DOC_ROOT = resolve(PLUGIN_ROOT, "docs/demo");
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

function materializeWarmSeed(
  databasePath: string,
  host: ReturnType<typeof createFakePluginHost>,
): void {
  const db = host.bb.storage.database();
  db.pragma("foreign_keys = OFF");
  db.prepare("ATTACH DATABASE ? AS warm_seed").run(databasePath);
  try {
    const tables = db
      .prepare(
        `SELECT name
           FROM warm_seed.sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            AND name != '_bb_migrations'
          ORDER BY name`,
      )
      .pluck()
      .all() as string[];
    for (const table of tables) {
      if (!/^[A-Za-z0-9_]+$/u.test(table)) {
        throw new Error(`Unsafe warm-seed table name: ${table}`);
      }
      db.exec(`DELETE FROM main.${table}`);
      db.exec(`INSERT INTO main.${table} SELECT * FROM warm_seed.${table}`);
    }
  } finally {
    db.exec("DETACH DATABASE warm_seed");
    db.pragma("foreign_keys = ON");
  }
}

async function productionSource(root: string): Promise<string> {
  const chunks: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) chunks.push(await productionSource(path));
    else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) {
      chunks.push(await readFile(path, "utf8"));
    }
  }
  return chunks.join("\n");
}

describe.sequential("Golden Loop offline gate", () => {
  it("pins the shipped sixteen-beat registry used by the canonical two-pass suite", () => {
    expect(GOLDEN_LOOP_BEATS).toHaveLength(16);
    expect(GOLDEN_LOOP_BEATS.map(({ number }) => number)).toEqual(
      Array.from({ length: 16 }, (_value, index) => index + 1),
    );
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

  it("guards promise DNS, HTTP/2, datagrams, and direct Socket.connect", () => {
    const guard = installedGuard("beat-07-extra-network-paths");
    expect(() => dnsPromises.lookup("example.invalid")).toThrow(
      UndeclaredNetworkError,
    );
    expect(() => http2.connect("https://example.invalid")).toThrow(
      UndeclaredNetworkError,
    );
    const udp = dgram.createSocket("udp4");
    try {
      expect(() => udp.connect(443, "198.51.100.11")).toThrow(
        UndeclaredNetworkError,
      );
    } finally {
      udp.close();
    }
    const socket = new net.Socket();
    expect(() => socket.connect(443, "198.51.100.12")).toThrow(
      UndeclaredNetworkError,
    );
    socket.destroy();
    expect(guard.violations.map(({ primitive }) => primitive)).toEqual([
      "dns",
      "http2",
      "dgram",
      "socket",
    ]);
  });

  it("executes every fenced runbook command through the shipped CLI", async () => {
    const host = createFakePluginHost({ pluginId: "finite-state" });
    await plugin(host.bb);
    const worktree = resolve(PLUGIN_ROOT, "test/e2e/golden-loop/seed/worktree");
    materializeWarmSeed(
      resolve(PLUGIN_ROOT, "test/e2e/golden-loop/seed/warm-cache/data.db"),
      host,
    );
    host.harness.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({
        id: threadId,
        projectId: "workspace-golden-loop",
        environmentId: "environment-golden-loop-docs",
      }),
    );
    host.harness.sdk.stub("environments.get", async ({ environmentId }) => ({
      id: environmentId,
      projectId: "workspace-golden-loop",
      hostId: "host-golden-loop-docs",
      path: worktree,
    }));
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
          expect(result.exitCode, `${name}: ${command}\n${result.stderr}`).toBe(
            0,
          );
        }
      }
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("keeps every documented recovery code grounded in product source", async () => {
    const guide = await readFile(
      resolve(DOC_ROOT, "FAILURE-RECOVERY.md"),
      "utf8",
    );
    const source = await Promise.all(
      ["lanes", "lib", "shared"].map((directory) =>
        productionSource(resolve(PLUGIN_ROOT, directory)),
      ),
    ).then((chunks) => chunks.join("\n"));
    for (const code of [
      "PLAN_CONFLICT_UNRESOLVED",
      "VEX_PARTIAL_FAILURE",
      "AMBIGUOUS_WRITE",
      "OVERLAY_CAS_CONFLICT",
      "MOUNT_INCOMPLETE",
      "FIRMWARE_ADMIN_BYTES_REQUIRED",
      "UNPACK_INPUT_DIGEST_MISMATCH",
      "FORGE_DISPATCH_AMBIGUOUS",
      "unverified",
      "invalid_signature",
      "stale_digest",
    ]) {
      expect(guide, `${code} is absent from the recovery guide`).toContain(
        `\`${code}\``,
      );
      expect(source, `${code} is absent from product source`).toContain(code);
    }
  });

  it("keeps documented seed counts and artifact paths grounded in the manifest", async () => {
    const seedRoot = resolve(PLUGIN_ROOT, "test/e2e/golden-loop/seed");
    const manifest = JSON.parse(
      await readFile(resolve(seedRoot, "manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      products: {
        v23: { pvId: "pv-ax3000-2.3", fileCount: 4 },
        v24: { pvId: "pv-ax3000-2.4", fileCount: 4 },
      },
      expected: {
        newUntriaged: 412,
        policyMatches: 306,
        policyWritten: 305,
        heldKev: 1,
        carryForwardRecovered: 14,
        stale: 9,
        orphans: 2,
      },
    });
    for (const path of [
      "warm-cache/data.db",
      "warm-cache/run-events.json",
      "worktree/.fs-firmware/pv-ax3000-2.3/manifest.sqlite",
      "worktree/.fs-firmware/pv-ax3000-2.4/manifest.sqlite",
      "attestations/ax3000-v24.dsse.json",
      "attestations/rfc8032-test-vector-1.pub.pem",
    ]) {
      await expect(readFile(resolve(seedRoot, path))).resolves.toBeTruthy();
    }
  });
});
