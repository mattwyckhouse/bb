import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceClaim } from "../../registry/claims.js";
import type { CaptureArtifactSink } from "../driver.js";
import type { ProcessRequest } from "../transport.js";
import {
  createScpiScopeDriver,
  parseSiglentWaveform,
  SIGLENT_SDS_PROFILE,
  type ScpiProfile,
} from "./scpi.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "fs129-scpi-"));
  directories.push(value);
  return value;
}

function claim(): DeviceClaim {
  return {
    deviceId: "scope-scpi-1",
    holder: "thread-1",
    scope: "machine",
    expiresAt: "2026-08-14T12:15:00.000Z",
  };
}

function sink(path = directory()): CaptureArtifactSink {
  return { directory: path, record: vi.fn(async () => undefined) };
}

function requestObject(value: unknown): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request was not an object");
  }
  return value;
}

function captureResponse(request: ProcessRequest): string {
  const payload: unknown = JSON.parse(request.args.at(-1) ?? "null");
  if (typeof payload !== "object" || payload === null)
    throw new Error("bad request");
  const outputDirectory = Reflect.get(payload, "outputDirectory");
  const samples = Reflect.get(payload, "samples");
  if (typeof outputDirectory !== "string" || typeof samples !== "number")
    throw new Error("bad request");
  const path = join(outputDirectory, "scpi-waveform.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema: "finite-state-scope-v1",
      sampleRateHz: Reflect.get(payload, "sampleRateHz"),
      channels: {
        C1: Array.from({ length: samples }, (_, index) => index / samples),
      },
    }),
    "utf8",
  );
  return JSON.stringify({
    path,
    format: "finite-state-scope-json-v1",
    durationMs: Reflect.get(payload, "durationMs"),
    channels: 1,
    channelConfigs: Reflect.get(payload, "channelConfigs"),
    trigger: Reflect.get(payload, "trigger"),
    sampleRateHz: Reflect.get(payload, "sampleRateHz"),
    samples,
  });
}

describe("SCPI/LAN scope driver", () => {
  it("identifies a Siglent SDS through *IDN? and maps dialect capabilities", async () => {
    const runner = vi.fn(async (_request: ProcessRequest) => ({
      code: 0,
      stdout: JSON.stringify({
        idn: "Siglent Technologies,SDS2104X Plus,SDS2XABC,1.3.9",
      }),
      stderr: "",
    }));
    const driver = createScpiScopeDriver({ runner, verifyClaim: vi.fn() });
    await expect(
      driver.detect({ kind: "lan", host: "scope.local", port: 5_025 }),
    ).resolves.toMatchObject({
      kind: "scope",
      features: expect.arrayContaining(["dialect:siglent-sds"]),
    });
    expect(runner.mock.calls[0]![0].args).toEqual([
      "-c",
      expect.any(String),
      "identify",
      JSON.stringify({ resource: "TCPIP0::scope.local::5025::SOCKET" }),
    ]);
  });

  it("drives the Siglent command table end to end through the LAN PyVISA resource", async () => {
    const runner = vi.fn(async (request: ProcessRequest) =>
      request.args.at(-2) === "identify"
        ? {
            code: 0,
            stdout: JSON.stringify({ idn: "Siglent,SDS1104X-E,serial,fw" }),
            stderr: "",
          }
        : { code: 0, stdout: captureResponse(request), stderr: "" },
    );
    const driver = createScpiScopeDriver({
      runner,
      verifyClaim: vi.fn(),
      resourceForDeviceId: () => "TCPIP0::192.0.2.8::5025::SOCKET",
    });
    const transport = { kind: "lan", host: "192.0.2.8", port: 5_025 } as const;
    await driver.detect(transport);
    const session = await driver.open(
      transport,
      claim(),
      new AbortController().signal,
    );
    const artifactSink = sink();
    await expect(
      session.capture(
        {
          durationMs: 10,
          sampleRateHz: 1_000,
          channels: [0],
          settings: {
            "channel.C1.rangeV": 8,
            "channel.C1.coupling": "dc",
            "channel.C1.attenuation": 10,
            "trigger.channel": "C1",
            "trigger.edge": "rising",
            "trigger.levelV": 2.5,
          },
          artifactSink,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      channelConfigs: [
        { channel: "C1", rangeV: 8, coupling: "dc", attenuation: 10 },
      ],
      trigger: { channel: "C1", edge: "rising", levelV: 2.5 },
    });
    const captureCall = runner.mock.calls.find(
      ([request]) => request.args.at(-2) === "capture",
    )!;
    const request: unknown = JSON.parse(captureCall[0].args.at(-1)!);
    expect(request).toMatchObject({
      resource: "TCPIP0::192.0.2.8::5025::SOCKET",
      armCommand: "ARM",
      triggerStatusCommand: "SAST?",
      waveformQueries: { C1: "C1:WF? DAT2" },
    });
    expect(Reflect.get(requestObject(request), "setupCommands")).toEqual(
      expect.arrayContaining([
        "STOP",
        "C1:TRA ON",
        "C1:VDIV 1V",
        "C1:CPL DC",
        "C1:TRSL POS",
        "C1:TRLV 2.5V",
      ]),
    );
    expect(artifactSink.record).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it("adds a second vendor as profile data without changing driver code", async () => {
    const secondProfile: ScpiProfile = {
      vendor: "acme-scope",
      commands: {
        ...SIGLENT_SDS_PROFILE.commands,
        channelScale: "CHAN{channel}:SCALE {scaleV}",
      },
      parseWaveform: SIGLENT_SDS_PROFILE.parseWaveform,
    };
    const runner = vi.fn(async (request: ProcessRequest) =>
      request.args.at(-2) === "identify"
        ? {
            code: 0,
            stdout: JSON.stringify({ idn: "ACME,Model 1,serial,fw" }),
            stderr: "",
          }
        : { code: 0, stdout: captureResponse(request), stderr: "" },
    );
    const driver = createScpiScopeDriver({
      runner,
      verifyClaim: vi.fn(),
      profiles: [SIGLENT_SDS_PROFILE, secondProfile],
      resourceForDeviceId: () => "TCPIP0::acme.local::5025::SOCKET",
    });
    const transport = { kind: "lan", host: "acme.local", port: 5_025 } as const;
    await expect(driver.detect(transport)).resolves.toMatchObject({
      features: expect.arrayContaining(["dialect:acme-scope"]),
    });
    const session = await driver.open(
      transport,
      claim(),
      new AbortController().signal,
    );
    await session.capture(
      {
        durationMs: 2,
        sampleRateHz: 1_000,
        channels: [0],
        artifactSink: sink(),
      },
      new AbortController().signal,
    );
    const captureCall = runner.mock.calls.find(
      ([request]) => request.args.at(-2) === "capture",
    )!;
    const request: unknown = JSON.parse(captureCall[0].args.at(-1)!);
    expect(Reflect.get(requestObject(request), "setupCommands")).toContain(
      "CHAN1:SCALE 0.625",
    );
    await session.close();
  });

  it("refuses a stale claim before LAN parsing or VISA I/O", async () => {
    const runner = vi.fn(async (_request: ProcessRequest) => ({
      code: 0,
      stdout: "{}",
      stderr: "",
    }));
    const driver = createScpiScopeDriver({
      runner,
      verifyClaim() {
        throw new Error("DEVICE_NOT_HELD");
      },
    });
    await expect(
      driver.open(
        { kind: "bb-host", hostId: "rack", remotePath: "/scope" },
        claim(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("DEVICE_NOT_HELD");
    expect(runner).not.toHaveBeenCalled();
  });

  it("cannot redirect a valid claim to a LAN resource absent from the registry", async () => {
    const runner = vi.fn(async (_request: ProcessRequest) => ({
      code: 0,
      stdout: JSON.stringify({ idn: "Siglent,SDS1104X-E,serial,fw" }),
      stderr: "",
    }));
    const driver = createScpiScopeDriver({
      runner,
      verifyClaim: vi.fn(),
      resourceForDeviceId: () => "TCPIP0::trusted.local::5025::SOCKET",
    });
    await expect(
      driver.open(
        { kind: "lan", host: "attacker.local", port: 5_025 },
        claim(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "INSTRUMENT_NOT_FOUND" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("turns a VISA connection drop mid-capture into typed DEVICE_LOST", async () => {
    const runner = vi.fn(async (request: ProcessRequest) =>
      request.args.at(-2) === "identify"
        ? {
            code: 0,
            stdout: JSON.stringify({ idn: "Siglent,SDS1104X-E,serial,fw" }),
            stderr: "",
          }
        : { code: 1, stdout: "", stderr: "VisaIOError: VI_ERROR_CONN_LOST" },
    );
    const releaseClaim = vi.fn();
    const driver = createScpiScopeDriver({
      runner,
      verifyClaim: vi.fn(),
      releaseClaim,
      resourceForDeviceId: () => "TCPIP0::scope.local::5025::SOCKET",
    });
    const transport = {
      kind: "lan",
      host: "scope.local",
      port: 5_025,
    } as const;
    await driver.detect(transport);
    const session = await driver.open(
      transport,
      claim(),
      new AbortController().signal,
    );
    await expect(
      session.capture(
        {
          durationMs: 2,
          sampleRateHz: 1_000,
          channels: [0],
          artifactSink: sink(),
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "DEVICE_LOST" });
    expect(releaseClaim).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed or truncated IEEE 488.2 waveform blocks", () => {
    expect(() => parseSiglentWaveform(new Uint8Array([1, 2, 3]))).toThrow(
      "definite-length block",
    );
    expect(() =>
      parseSiglentWaveform(new TextEncoder().encode("#210abc")),
    ).toThrow("truncated");
    const parsed = parseSiglentWaveform(
      new Uint8Array([35, 49, 51, 0, 25, 231]),
    );
    expect(parsed.channels.C1).toEqual([0, 1, -1]);
  });

  it("reports PyVISA and its working backend as distinct confirmed-remediation prerequisites", () => {
    const driver = createScpiScopeDriver({
      verifyClaim: vi.fn(),
      prerequisiteReport: () => ({
        configured: false,
        needsConfiguration: [
          {
            key: "scope.pyvisa",
            configured: false,
            remediation: "confirm pyvisa",
          },
          {
            key: "scope.pyvisa-py-backend",
            configured: false,
            remediation: "confirm backend",
          },
        ],
      }),
    });
    expect(
      driver.prerequisites().needsConfiguration.map((item) => item.key),
    ).toEqual(["scope.pyvisa", "scope.pyvisa-py-backend"]);
  });
});
