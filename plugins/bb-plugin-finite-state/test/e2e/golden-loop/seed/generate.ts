import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { BbPluginApi } from "@bb/plugin-sdk";
import Database from "better-sqlite3";

import { openStore } from "../../../../lib/store/index.js";
import { MIGRATIONS } from "../../../../lib/store/schema.js";
import type { Json } from "../../../../lib/remote/types.js";
import { pullFindings } from "../../../../lanes/findings/cache/pull.js";
import type { FindingsDeps } from "../../../../lanes/findings/cache/types.js";
import {
  openManifest,
  verifyMountIntegrity,
  type FirmwareNode,
} from "../../../../lanes/firmware/cache/manifest.js";
import { MANIFEST_MIGRATIONS } from "../../../../lanes/firmware/cache/manifest-schema.js";
import { pull } from "../../../../lanes/sync/engine/pull.js";

const execFileAsync = promisify(execFile);
const GENERATED_AT = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = "project-ax3000-demo";
const V23_ID = "pv-ax3000-2.3";
const V24_ID = "pv-ax3000-2.4";
const GENERATOR_VERSION = "wp66-v1";
const EXPECTED = {
  newUntriaged: 412,
  policyMatches: 306,
  policyWritten: 305,
  heldKev: 1,
  carryForwardRecovered: 14,
  stale: 9,
  orphans: 2,
} as const;

export type GoldenSeedManifest = {
  seedVersion: 1;
  sourceSeed: string;
  generatedAt: string;
  products: {
    v23: { pvId: string; firmwareDigest: string; fileCount: number };
    v24: { pvId: string; firmwareDigest: string; fileCount: number };
  };
  expected: typeof EXPECTED;
  artifacts: Array<{
    path: string;
    sha256: string;
    purpose: string;
    schemaVersion?: number;
  }>;
};

type Story = {
  generatorVersion: typeof GENERATOR_VERSION;
  project: { id: typeof PROJECT_ID; product: "AX3000" };
  versions: {
    v23: { pvId: typeof V23_ID; components: ["COMP-httpd"] };
    v24: { pvId: typeof V24_ID; components: ["COMP-httpd"] };
  };
  counts: typeof EXPECTED;
  links: {
    kev: "CVE-2026-31337";
    component: "COMP-httpd";
    threat: "THREAT-22";
    requirementAbsentAtStart: "REQ-118";
    attackPath: "ATTACK-PATH-WAN-HTTPD";
    craClause: "CRA-ANNEX-I-1.2";
    check: "CHECK-HTTPD-WAN";
  };
  drift: {
    recovered: string[];
    stale: string[];
    orphans: string[];
  };
  policy: { matched: string[]; written: string[]; held: string[] };
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, json(value), "utf8");
}

function findingRows(seed: number): Record<string, Json>[] {
  return Array.from({ length: EXPECTED.newUntriaged }, (_, index) => {
    const ordinal = index + 1;
    const kev = index === 0;
    const policyMatch = index < EXPECTED.policyMatches;
    const cve = kev
      ? "CVE-2026-31337"
      : `CVE-2026-${String(40_000 + seed * 1_000 + ordinal).padStart(5, "0")}`;
    const componentName = kev ? "httpd" : `ax3000-component-${ordinal}`;
    return {
      id: `FINDING-${String(ordinal).padStart(4, "0")}`,
      findingId: cve,
      cve,
      title: `${cve} on ${componentName}`,
      type: "cve",
      severity: policyMatch ? "high" : "low",
      inKev: kev,
      warnings: 0,
      violations: policyMatch ? 1 : 0,
      reachabilityScore: policyMatch ? 9 : 0,
      reachability: {
        verdict: policyMatch ? "reachable" : "unreachable",
        factors: policyMatch ? ["WAN ingress", "http parser"] : ["no path"],
      },
      component: {
        id: kev ? "COMP-httpd" : `COMP-${String(ordinal).padStart(4, "0")}`,
        name: componentName,
        version: kev ? "2.3.1" : "1.0.0",
        purl: kev
          ? "pkg:generic/httpd@2.3.1"
          : `pkg:generic/ax3000-component-${ordinal}@1.0.0`,
      },
      detected: GENERATED_AT,
    };
  });
}

async function createWarmDatabase(path: string, seed: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const database = new Database(path);
  const storageBoundary = {
    database: () => database,
    migrate(db: Database.Database, statements: readonly string[]) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      const applied = new Set(
        (
          db.prepare("SELECT id FROM _bb_migrations").all() as Array<{
            id: number;
          }>
        ).map(({ id }) => id),
      );
      const record = db.prepare(
        "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
      );
      db.transaction(() => {
        statements.forEach((statement, index) => {
          if (applied.has(index)) return;
          db.exec(statement);
          record.run(index, Date.parse(GENERATED_AT));
        });
      })();
    },
  };
  // Deliberate host boundary: production openStore only consumes storage;
  // the E2E generator supplies that primitive with a real file-backed DB.
  const store = openStore({ storage: storageBoundary } as BbPluginApi);
  const rows = findingRows(seed);
  const platform: FindingsDeps["platform"] = {
    async *getFindings() {
      for (let offset = 0; offset < rows.length; offset += 137) {
        const items = rows.slice(offset, offset + 137);
        yield {
          items,
          next:
            offset + items.length < rows.length
              ? String(offset + items.length)
              : null,
          total: rows.length,
        };
      }
    },
  };
  await pull(
    {
      db: store.db,
      now: () => new Date(GENERATED_AT),
      createGenerationId: () => `golden-seed-${seed}-findings`,
      adapters: [],
      cachePullers: [
        {
          kind: "finding",
          pull: async (scope, generationId, onProgress) => {
            const result = await pullFindings(
              { db: store.db, platform, pageSize: 137 },
              scope,
              generationId,
              onProgress,
            );
            return {
              fetched: result.fetched,
              baseRows: result.published,
              quarantined: result.quarantined,
              advisories: result.advisories,
            };
          },
        },
      ],
    },
    { projectId: PROJECT_ID, projectVersionId: V24_ID },
    ["finding"],
  );
  store.db
    .prepare("UPDATE _bb_migrations SET applied_at = ?")
    .run(Date.parse(GENERATED_AT));
  store.db.pragma("journal_mode = DELETE");
  store.db.exec("VACUUM");
  store.db.close();
}

const FILES = {
  v23: {
    "/etc/ax3000-release": "AX3000_VERSION=2.3\n",
    "/usr/sbin/httpd": "ELF-TEST:httpd:2.3.1:vulnerable-parser\n",
    "/etc/httpd/httpd.conf": "listen=0.0.0.0:80\nwan=true\n",
    "/lib/libcrypto.so": "ELF-TEST:libcrypto:3.0.0\n",
  },
  v24: {
    "/etc/ax3000-release": "AX3000_VERSION=2.4\n",
    "/usr/sbin/httpd": "ELF-TEST:httpd:2.3.1:bounded-parser\n",
    "/etc/httpd/httpd.conf":
      "listen=0.0.0.0:80\nwan=true\nrequest_limit=8192\n",
    "/lib/libcrypto.so": "ELF-TEST:libcrypto:3.0.0\n",
  },
} as const;

function firmwareDigest(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort()) {
    hash.update(path).update("\0").update(files[path]!).update("\0");
  }
  return hash.digest("hex");
}

async function initializeNestedWorktree(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".gitignore"), ".fs-firmware/\n", "utf8");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
}

async function createFirmware(
  worktree: string,
  pvId: string,
  files: Readonly<Record<string, string>>,
  fullyMaterialized: boolean,
  unpackErrors: string[] = [],
): Promise<{ digest: string; fileCount: number }> {
  const rootfs = join(worktree, ".fs-firmware", pvId, "rootfs");
  const nodes: FirmwareNode[] = [];
  const directories = new Set<string>();
  for (const [virtualPath, content] of Object.entries(files)) {
    const relativePath = virtualPath.slice(1);
    const diskPath = join(rootfs, relativePath);
    await mkdir(dirname(diskPath), { recursive: true });
    await writeFile(diskPath, content, "utf8");
    await chmod(diskPath, 0o755);
    let parent = dirname(virtualPath);
    while (parent !== "/" && parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
    nodes.push({
      path: virtualPath,
      kind: "file",
      fileHash: sha256(content),
      size: Buffer.byteLength(content),
      mimeType: "application/octet-stream",
      fullType: "Golden Loop synthetic firmware bytes",
      unixMode: 0o755,
      symlinkTarget: null,
      materialized: true,
      errors: [],
    });
  }
  for (const path of [...directories].sort())
    nodes.push({
      path,
      kind: "directory",
      fileHash: null,
      size: null,
      mimeType: null,
      fullType: null,
      unixMode: 0o755,
      symlinkTarget: null,
      materialized: false,
      errors: [],
    });
  const digest = firmwareDigest(files);
  const manifest = openManifest(worktree, pvId);
  if (manifest.invalidReason) throw new Error(manifest.invalidReason);
  manifest.replaceNodes(nodes, {
    pvId,
    scanId: `scan-${pvId}`,
    inputSha256: digest,
    source: "standalone_unpack",
    artifactHash: digest,
    fullyMaterialized,
    materializedAt: GENERATED_AT,
    nodeCount: nodes.length,
    hydratedCount: Object.keys(files).length,
    adminBytesOk: null,
    unpackErrors,
    stale: false,
  });
  verifyMountIntegrity(manifest);
  manifest.database
    .prepare("UPDATE _fs_migrations SET applied_at = ?")
    .run(GENERATED_AT);
  manifest.database.pragma("wal_checkpoint(TRUNCATE)");
  manifest.database.pragma("journal_mode = DELETE");
  const manifestFile = manifest.path;
  manifest.close();
  await rm(`${manifestFile}-wal`, { force: true });
  await rm(`${manifestFile}-shm`, { force: true });
  return { digest, fileCount: Object.keys(files).length };
}

function story(): Story {
  const matched = Array.from(
    { length: EXPECTED.policyMatches },
    (_, index) => `FINDING-${String(index + 1).padStart(4, "0")}`,
  );
  return {
    generatorVersion: GENERATOR_VERSION,
    project: { id: PROJECT_ID, product: "AX3000" },
    versions: {
      v23: { pvId: V23_ID, components: ["COMP-httpd"] },
      v24: { pvId: V24_ID, components: ["COMP-httpd"] },
    },
    counts: EXPECTED,
    links: {
      kev: "CVE-2026-31337",
      component: "COMP-httpd",
      threat: "THREAT-22",
      requirementAbsentAtStart: "REQ-118",
      attackPath: "ATTACK-PATH-WAN-HTTPD",
      craClause: "CRA-ANNEX-I-1.2",
      check: "CHECK-HTTPD-WAN",
    },
    drift: {
      recovered: Array.from({ length: 14 }, (_, index) => `CF-${index + 1}`),
      stale: Array.from({ length: 9 }, (_, index) => `STALE-${index + 1}`),
      orphans: ["ORPHAN-1", "ORPHAN-2"],
    },
    policy: {
      matched,
      written: matched.slice(1),
      held: [matched[0]!],
    },
  };
}

const TEST_VECTOR_SEED = Buffer.from(
  "9d61b19deffd5a60ba844af492ec2cc4" + "4449c5697b326919703bac031cae7f60",
  "hex",
);

function dssePayload(firmware: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "AX3000-v2.4-firmware", digest: { sha256: firmware } }],
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        buildDefinition: { buildType: "bb.test/offline-golden-loop" },
        runDetails: {
          builder: { id: "bb.test/finite-state-golden-seed" },
          metadata: { invocationId: "RUN-OFFLINE-AX3000-24" },
        },
      },
    }),
  );
}

function pae(payloadType: string, payload: Buffer): Buffer {
  return Buffer.from(
    `DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} ${payload.toString()}`,
  );
}

async function createAttestation(
  root: string,
  firmware: string,
): Promise<void> {
  const payloadType = "application/vnd.in-toto+json";
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    TEST_VECTOR_SEED,
  ]);
  const privateKey = createPrivateKey({
    key: pkcs8,
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  const payload = dssePayload(firmware);
  const signature = sign(null, pae(payloadType, payload), privateKey);
  await writeJson(join(root, "attestations", "ax3000-v24.dsse.json"), {
    fixtureIdentity:
      "TEST ONLY — RFC 8032 vector identity; no public Rekor inclusion",
    payloadType,
    payload: payload.toString("base64"),
    signatures: [
      { keyid: "rfc8032-test-vector-1", sig: signature.toString("base64") },
    ],
    transparencyLog: {
      included: false,
      service: "none",
      reason: "offline test fixture",
    },
  });
  await writeFile(
    join(root, "attestations", "rfc8032-test-vector-1.pub.pem"),
    publicKey.export({ type: "spki", format: "pem" }),
  );
}

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )) {
      if (
        entry.name === ".git" ||
        entry.name.endsWith("-wal") ||
        entry.name.endsWith("-shm")
      )
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  await walk(root);
  return result.sort();
}

function purpose(path: string): string {
  if (path.endsWith("data.db"))
    return "production-migrated offline finding cache";
  if (path.endsWith("manifest.sqlite"))
    return "production firmware mount manifest";
  if (path.includes("attestations/"))
    return "offline test attestation verification material";
  if (path.includes("pv-ax3000-unpack-gap/rootfs/"))
    return "explicit non-fatal unpack-gap honesty fixture";
  if (path.includes("rootfs/"))
    return "fully materialized synthetic firmware file";
  if (path.endsWith("story.json"))
    return "Golden Loop identities, counts, and drift cross-links";
  if (path.endsWith("trace.json"))
    return "source, binary, firmware, run, and attestation trace links";
  if (path.endsWith("run-events.json"))
    return "deterministic offline bench run and event sequence";
  if (path.endsWith("cra-clause.json"))
    return "CRA clause, check, and missing-requirement fixture";
  if (path.endsWith("THREAT-22.json"))
    return "reachable KEV threat and WAN attack-path fixture";
  if (path.endsWith(".gitignore"))
    return "firmware cache repository-safety fixture";
  if (path.endsWith("generate.ts"))
    return "versioned deterministic Golden Loop generator";
  if (path.endsWith("seed.test.ts"))
    return "seed determinism, integrity, and safety tests";
  if (path.includes("src/")) return "traceable source repair fixture";
  return "deterministic Golden Loop seed artifact";
}

export async function generateGoldenSeed(
  destination: string,
  seed: number,
): Promise<GoldenSeedManifest> {
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new Error("seed must be a non-negative integer");
  const root = resolve(destination);
  await mkdir(root, { recursive: true });
  for (const owned of ["worktree", "warm-cache", "attestations"])
    await rm(join(root, owned), { recursive: true, force: true });
  const worktree = join(root, "worktree");
  await initializeNestedWorktree(worktree);
  const sourceBefore =
    "/* Golden Loop synthetic source v2.3 */\nint request_limit(void) { return -1; }\n";
  const sourceAfter =
    "/* Golden Loop synthetic source */\nint request_limit(void) { return 8192; }\n";
  await mkdir(join(worktree, "src", "v2.3"), { recursive: true });
  await mkdir(join(worktree, "src", "v2.4"), { recursive: true });
  await writeFile(
    join(worktree, "src", "v2.3", "httpd.c"),
    sourceBefore,
    "utf8",
  );
  await writeFile(
    join(worktree, "src", "v2.4", "httpd.c"),
    sourceAfter,
    "utf8",
  );
  await writeJson(join(worktree, ".fs", "golden-loop", "story.json"), story());
  await writeJson(join(worktree, ".fs", "threats", "THREAT-22.json"), {
    id: "THREAT-22",
    component: "COMP-httpd",
    finding: "CVE-2026-31337",
    attackPath: {
      id: "ATTACK-PATH-WAN-HTTPD",
      crosses: ["WAN", "dmz", "httpd"],
    },
  });
  await writeJson(join(worktree, ".fs", "compliance", "cra-clause.json"), {
    clause: "CRA-ANNEX-I-1.2",
    check: "CHECK-HTTPD-WAN",
    missingRequirement: "REQ-118",
  });
  const v23 = await createFirmware(worktree, V23_ID, FILES.v23, true);
  const v24 = await createFirmware(worktree, V24_ID, FILES.v24, true);
  await writeJson(join(worktree, ".fs", "golden-loop", "trace.json"), {
    source: {
      before: { path: "src/v2.3/httpd.c", sha256: sha256(sourceBefore) },
      after: { path: "src/v2.4/httpd.c", sha256: sha256(sourceAfter) },
    },
    binary: {
      path: `.fs-firmware/${V24_ID}/rootfs/usr/sbin/httpd`,
      sha256: sha256(FILES.v24["/usr/sbin/httpd"]),
    },
    firmware: { pvId: V24_ID, sha256: v24.digest },
    run: "RUN-OFFLINE-AX3000-24",
    attestation: "attestations/ax3000-v24.dsse.json",
  });
  await createFirmware(
    worktree,
    "pv-ax3000-unpack-gap",
    { "/README.txt": "non-fatal unpack gap honesty fixture\n" },
    false,
    ["TEST_GAP: optional squashfs segment intentionally unavailable"],
  );
  await createWarmDatabase(join(root, "warm-cache", "data.db"), seed);
  await writeJson(join(root, "warm-cache", "run-events.json"), {
    runId: "RUN-OFFLINE-AX3000-24",
    firmwareDigest: v24.digest,
    events: [
      { sequence: 1, at: GENERATED_AT, type: "queued" },
      { sequence: 2, at: "2026-01-01T00:00:01.000Z", type: "started" },
      {
        sequence: 3,
        at: "2026-01-01T00:00:02.000Z",
        type: "completed",
        result: "verified",
      },
    ],
  });
  await createAttestation(root, v24.digest);
  // The nested repository exists only so production firmware layout guards
  // run during generation. The committed harness copy is ordinary data.
  await rm(join(worktree, ".git"), { recursive: true, force: true });
  const sourceManifest = await readFile(
    resolve(import.meta.dirname, "../../../mock-remote/fixtures/manifest.json"),
  );
  const products = {
    v23: { pvId: V23_ID, firmwareDigest: v23.digest, fileCount: v23.fileCount },
    v24: { pvId: V24_ID, firmwareDigest: v24.digest, fileCount: v24.fileCount },
  };
  const artifactPaths = (await filesBelow(root)).filter(
    (path) => relative(root, path) !== "manifest.json",
  );
  const artifacts = await Promise.all(
    artifactPaths.map(async (path) => {
      const relativePath = relative(root, path).split(sep).join("/");
      const artifact = {
        path: relativePath,
        sha256: sha256(await readFile(path)),
        purpose: purpose(relativePath),
      };
      if (relativePath.endsWith("data.db"))
        return { ...artifact, schemaVersion: MIGRATIONS.length };
      if (relativePath.endsWith("manifest.sqlite"))
        return { ...artifact, schemaVersion: MANIFEST_MIGRATIONS.length };
      return artifact;
    }),
  );
  const manifest: GoldenSeedManifest = {
    seedVersion: 1,
    sourceSeed: `wp08-sha256:${sha256(sourceManifest)}`,
    generatedAt: GENERATED_AT,
    products,
    expected: EXPECTED,
    artifacts,
  };
  await writeJson(join(root, "manifest.json"), manifest);
  return manifest;
}

function parseManifest(value: unknown): GoldenSeedManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("manifest schema mismatch: root must be an object");
  const manifest = value as Partial<GoldenSeedManifest>;
  if (
    manifest.seedVersion !== 1 ||
    manifest.generatedAt !== GENERATED_AT ||
    manifest.expected?.newUntriaged !== 412 ||
    !Array.isArray(manifest.artifacts)
  )
    throw new Error("manifest schema mismatch");
  return manifest as GoldenSeedManifest;
}

export function semanticDatabaseDump(path: string): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true });
  try {
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .pluck()
        .all() as string[]
    ).filter((name) => name !== "_bb_migrations");
    return Object.fromEntries(
      tables.map((table) => {
        if (!/^[A-Za-z0-9_]+$/u.test(table))
          throw new Error("unsafe SQLite table name");
        return [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ];
      }),
    );
  } finally {
    db.close();
  }
}

export async function verifyGoldenSeed(rootInput: string): Promise<void> {
  const root = resolve(rootInput);
  const manifest = parseManifest(
    JSON.parse(await readFile(join(root, "manifest.json"), "utf8")),
  );
  const actualPaths = (await filesBelow(root))
    .map((path) => relative(root, path).split(sep).join("/"))
    .filter((path) => path !== "manifest.json");
  const declaredPaths = manifest.artifacts.map(({ path }) => path).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(declaredPaths))
    throw new Error("artifact inventory mismatch");
  for (const artifact of manifest.artifacts) {
    const actual = sha256(await readFile(join(root, artifact.path)));
    if (actual !== artifact.sha256)
      throw new Error(`integrity error: ${artifact.path}`);
  }
  const storyValue = JSON.parse(
    await readFile(
      join(root, "worktree", ".fs", "golden-loop", "story.json"),
      "utf8",
    ),
  ) as Story;
  if (
    JSON.stringify(storyValue.counts) !== JSON.stringify(manifest.expected) ||
    storyValue.policy.matched.length !== 306 ||
    storyValue.policy.written.length !== 305 ||
    storyValue.policy.held.length !== 1 ||
    storyValue.drift.recovered.length !== 14 ||
    storyValue.drift.stale.length !== 9 ||
    storyValue.drift.orphans.length !== 2 ||
    storyValue.links.kev !== "CVE-2026-31337" ||
    storyValue.links.component !== "COMP-httpd" ||
    storyValue.links.threat !== "THREAT-22" ||
    storyValue.links.requirementAbsentAtStart !== "REQ-118"
  )
    throw new Error("Golden Loop story cross-link mismatch");
  const trace = JSON.parse(
    await readFile(
      join(root, "worktree", ".fs", "golden-loop", "trace.json"),
      "utf8",
    ),
  ) as {
    source: {
      before: { path: string; sha256: string };
      after: { path: string; sha256: string };
    };
    binary: { path: string; sha256: string };
    firmware: { pvId: string; sha256: string };
    run: string;
    attestation: string;
  };
  const traceRoot = join(root, "worktree");
  if (
    trace.source.before.sha256 !==
      sha256(await readFile(join(traceRoot, trace.source.before.path))) ||
    trace.source.after.sha256 !==
      sha256(await readFile(join(traceRoot, trace.source.after.path))) ||
    trace.binary.sha256 !==
      sha256(await readFile(join(traceRoot, trace.binary.path))) ||
    trace.firmware.pvId !== manifest.products.v24.pvId ||
    trace.firmware.sha256 !== manifest.products.v24.firmwareDigest ||
    trace.run !== "RUN-OFFLINE-AX3000-24" ||
    trace.attestation !== "attestations/ax3000-v24.dsse.json"
  )
    throw new Error("Golden Loop trace cross-link mismatch");
  const dataDb = new Database(join(root, "warm-cache", "data.db"), {
    readonly: true,
  });
  try {
    const migrationCount = dataDb
      .prepare("SELECT COUNT(*) FROM _bb_migrations")
      .pluck()
      .get();
    const findingCount = dataDb
      .prepare("SELECT COUNT(*) FROM findings")
      .pluck()
      .get();
    const kev = dataDb
      .prepare("SELECT component_name, cve, in_kev FROM findings WHERE cve = ?")
      .get("CVE-2026-31337") as
      | { component_name: string; cve: string; in_kev: number }
      | undefined;
    if (migrationCount !== MIGRATIONS.length)
      throw new Error("data.db schema mismatch");
    if (
      findingCount !== EXPECTED.newUntriaged ||
      kev?.component_name !== "httpd" ||
      kev.in_kev !== 1
    )
      throw new Error("data.db Golden Loop cross-link mismatch");
  } finally {
    dataDb.close();
  }
  const worktree = join(root, "worktree");
  for (const product of [manifest.products.v23, manifest.products.v24]) {
    const manifestPath = join(
      worktree,
      ".fs-firmware",
      product.pvId,
      "manifest.sqlite",
    );
    const firmware = new Database(manifestPath, { readonly: true });
    try {
      const migrations = firmware
        .prepare("SELECT COUNT(*) FROM _fs_migrations")
        .pluck()
        .get();
      const meta = new Map(
        (
          firmware.prepare("SELECT key, value FROM fs_meta").all() as Array<{
            key: string;
            value: string;
          }>
        ).map(({ key, value }) => [key, JSON.parse(value) as unknown]),
      );
      const nodes = firmware
        .prepare(
          "SELECT path, file_hash, size, materialized, errors FROM fs_node WHERE kind = 'file' ORDER BY path",
        )
        .all() as Array<{
        path: string;
        file_hash: string;
        size: number;
        materialized: number;
        errors: string;
      }>;
      let coherent = true;
      for (const node of nodes) {
        const bytes = await readFile(
          join(
            worktree,
            ".fs-firmware",
            product.pvId,
            "rootfs",
            node.path.slice(1),
          ),
        );
        coherent &&=
          node.materialized === 1 &&
          node.errors === "[]" &&
          node.size === bytes.length &&
          sha256(bytes) === node.file_hash;
      }
      if (
        migrations !== MANIFEST_MIGRATIONS.length ||
        meta.get("artifact_hash") !== product.firmwareDigest ||
        meta.get("fully_materialized") !== true ||
        nodes.length !== product.fileCount ||
        !coherent
      )
        throw new Error(`${product.pvId} firmware cross-link mismatch`);
    } finally {
      firmware.close();
    }
  }
  const envelope = JSON.parse(
    await readFile(join(root, "attestations", "ax3000-v24.dsse.json"), "utf8"),
  ) as {
    payloadType: string;
    payload: string;
    signatures: Array<{ sig: string }>;
    transparencyLog: { included: boolean };
    fixtureIdentity: string;
  };
  const payload = Buffer.from(envelope.payload, "base64");
  const statement = JSON.parse(payload.toString()) as {
    subject: Array<{ digest: { sha256: string } }>;
  };
  if (
    statement.subject[0]?.digest.sha256 !== manifest.products.v24.firmwareDigest
  )
    throw new Error("attestation subject mismatch");
  if (
    envelope.transparencyLog.included ||
    !envelope.fixtureIdentity.startsWith("TEST ONLY")
  )
    throw new Error("attestation provenance safety mismatch");
  const publicKey = createPublicKey(
    await readFile(
      join(root, "attestations", "rfc8032-test-vector-1.pub.pem"),
      "utf8",
    ),
  );
  if (
    !verify(
      null,
      pae(envelope.payloadType, payload),
      publicKey,
      Buffer.from(envelope.signatures[0]?.sig ?? "", "base64"),
    )
  )
    throw new Error("attestation signature mismatch");
}

async function isEntrypoint(): Promise<boolean> {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return (
    (await realpath(argvPath).catch(() => resolve(argvPath))) ===
    fileURLToPath(import.meta.url)
  );
}

if (await isEntrypoint()) {
  const verifyIndex = process.argv.indexOf("--verify");
  if (verifyIndex >= 0) {
    await verifyGoldenSeed(
      process.argv[verifyIndex + 1] ?? import.meta.dirname,
    );
  } else {
    const destination = process.argv[2] ?? import.meta.dirname;
    const seed = Number(process.argv[3] ?? "66");
    await generateGoldenSeed(destination, seed);
  }
}
