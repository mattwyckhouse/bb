import { spawnSync } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CaptureConfig,
  InstrumentCapabilities,
  InstrumentDriver,
  InstrumentDriverDeps,
  PrerequisiteReport,
} from "../driver.js";
import { validateCaptureConfig } from "../driver.js";
import {
  DeviceLostError,
  InstrumentError,
  resolveInstrumentTransport,
  runInstrumentProcess,
  TransportError,
  type ProcessResult,
} from "../transport.js";
import type {
  ScopeCapture,
  ScopeChannelConfig,
  ScopeTrigger,
  WaveformData,
} from "./waveform.js";

const MAX_CAPTURE_MS = 60_000;
const MAX_CAPTURE_SAMPLES = 10_000_000;
const MAX_BRIDGE_OUTPUT_BYTES = 256 * 1024;

class ScopeTriggerTimeoutError extends Error {
  readonly code = "TRIGGER_TIMEOUT" as const;
  constructor(
    message: string,
    readonly armedConfiguration: {
      channelConfigs: ScopeChannelConfig[];
      trigger: ScopeTrigger;
      sampleRateHz: number;
      samples: number;
    },
  ) {
    super(`TRIGGER_TIMEOUT: ${message}`);
    this.name = "ScopeTriggerTimeoutError";
  }
}

export interface ScpiProfile {
  readonly vendor: string;
  readonly commands: Readonly<Record<string, string>>;
  parseWaveform(raw: Uint8Array): WaveformData;
}

const SIGLENT_COMMANDS = Object.freeze({
  idn: "*IDN?",
  stop: "STOP",
  run: "RUN",
  arm: "ARM",
  triggerStatus: "SAST?",
  channelDisplay: "C{channel}:TRA ON",
  channelScale: "C{channel}:VDIV {scaleV}V",
  channelCoupling: "C{channel}:CPL {coupling}",
  triggerType: "TRSE EDGE,SR,C{channel},HT,OFF",
  triggerSlope: "C{channel}:TRSL {edge}",
  triggerLevel: "C{channel}:TRLV {levelV}V",
  memoryDepth: "MSIZ {samples}",
  waveformSource: "WFSU SP,0,NP,{samples},FP,0",
  waveformQuery: "C{channel}:WF? DAT2",
} as const);

function parseDefiniteBlock(raw: Uint8Array): Int8Array {
  if (raw.length < 3 || raw[0] !== 35) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "SCPI waveform is not an IEEE 488.2 definite-length block.",
    );
  }
  const digits = raw[1]! - 48;
  if (
    !Number.isInteger(digits) ||
    digits < 1 ||
    digits > 9 ||
    raw.length < 2 + digits
  ) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "SCPI waveform block header is malformed.",
    );
  }
  let lengthText: string;
  try {
    lengthText = new TextDecoder("ascii", { fatal: true }).decode(
      raw.slice(2, 2 + digits),
    );
  } catch (error) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "SCPI waveform block length is not ASCII.",
      { cause: error },
    );
  }
  if (!/^\d+$/u.test(lengthText)) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "SCPI waveform block length is malformed.",
    );
  }
  const length = Number(lengthText);
  const from = 2 + digits;
  if (
    length < 1 ||
    length > MAX_CAPTURE_SAMPLES ||
    raw.length < from + length
  ) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "SCPI waveform block is truncated or exceeds the sample bound.",
    );
  }
  const bytes = raw.slice(from, from + length);
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function parseSiglentWaveform(raw: Uint8Array): WaveformData {
  const samples = parseDefiniteBlock(raw);
  return {
    sampleRateHz: 1,
    channels: { C1: Array.from(samples, (sample) => sample / 25) },
  };
}

export const SIGLENT_SDS_PROFILE: ScpiProfile = Object.freeze({
  vendor: "siglent-sds",
  commands: SIGLENT_COMMANDS,
  parseWaveform: parseSiglentWaveform,
});

export const PYVISA_BRIDGE = String.raw`
import json, os, sys, time
import pyvisa

action = sys.argv[1]
request = json.loads(sys.argv[2])
rm = pyvisa.ResourceManager("@py")
instrument = rm.open_resource(request["resource"], open_timeout=3000)
instrument.timeout = request.get("ioTimeoutMs", 5000)
try:
    if action == "identify":
        print(json.dumps({"idn": instrument.query("*IDN?").strip()}))
    elif action == "capture":
        for command in request["setupCommands"]:
            instrument.write(command)
        instrument.write(request["armCommand"])
        deadline = time.monotonic() + request["triggerTimeoutMs"] / 1000.0
        triggered = False
        while time.monotonic() < deadline:
            status = instrument.query(request["triggerStatusCommand"]).strip().lower()
            if status in ("stop", "stopped", "trig'd", "triggered"):
                triggered = True
                break
            time.sleep(0.01)
        if not triggered:
            instrument.write(request["stopCommand"])
            print(json.dumps({"armedConfiguration": request}), flush=True)
            sys.exit(42)
        os.makedirs(request["outputDirectory"], exist_ok=True)
        channels = {}
        for channel in request["channelConfigs"]:
            raw = instrument.query_binary_values(
                request["waveformQueries"][channel["channel"]],
                datatype="b", is_big_endian=False, container=list,
            )
            scale = channel["rangeV"] / 100.0 * channel["attenuation"]
            channels[channel["channel"]] = [sample * scale for sample in raw]
        path = os.path.join(request["outputDirectory"], "scpi-waveform.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"schema": "finite-state-scope-v1", "sampleRateHz": request["sampleRateHz"], "channels": channels}, handle)
        print(json.dumps({"path": path, "format": "finite-state-scope-json-v1", "durationMs": request["durationMs"], "channels": len(channels), "channelConfigs": request["channelConfigs"], "trigger": request.get("trigger"), "sampleRateHz": request["sampleRateHz"], "samples": len(next(iter(channels.values())))}))
    else:
        raise ValueError("unsupported action")
finally:
    try: instrument.close()
    finally: rm.close()
`;

export interface ScpiScopeDriverDeps extends InstrumentDriverDeps {
  profiles?: readonly ScpiProfile[];
  resourceForDeviceId?: (deviceId: string) => string | null;
}

let configuredPrerequisites: PrerequisiteReport | null = null;

function defaultPrerequisites(): PrerequisiteReport {
  if (configuredPrerequisites !== null) return configuredPrerequisites;
  const pyvisa = spawnSync("python3", ["-c", "import pyvisa"], {
    shell: false,
    timeout: 3_000,
    stdio: "ignore",
  });
  const backend =
    pyvisa.status === 0
      ? spawnSync(
          "python3",
          ["-c", "import pyvisa; r=pyvisa.ResourceManager('@py'); r.close()"],
          {
            shell: false,
            timeout: 3_000,
            stdio: "ignore",
          },
        )
      : null;
  const items = [
    {
      key: "scope.pyvisa",
      configured: pyvisa.status === 0,
      remediation: "Install PyVISA through the confirmed helper-install flow.",
    },
    {
      key: "scope.pyvisa-py-backend",
      configured: backend?.status === 0,
      remediation:
        "Install and configure pyvisa-py through the confirmed helper-install flow.",
    },
  ].filter((item) => !item.configured);
  const report = { configured: items.length === 0, needsConfiguration: items };
  if (report.configured) configuredPrerequisites = report;
  return report;
}

function responseObject(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "PyVISA bridge returned malformed JSON.",
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "PyVISA bridge returned a non-object response.",
    );
  }
  return Object.fromEntries(Object.entries(parsed));
}

function profileForIdn(
  idn: string,
  profiles: readonly ScpiProfile[],
): ScpiProfile | null {
  const normalized = idn.toLowerCase();
  return (
    profiles.find((profile) =>
      normalized.includes(profile.vendor.split("-")[0]!.toLowerCase()),
    ) ?? null
  );
}

function render(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(
    /\{([A-Za-z][A-Za-z0-9]*)\}/gu,
    (_match, key: string) => {
      const value = values[key];
      if (value === undefined)
        throw new InstrumentError(
          "INSTRUMENT_PROTOCOL_ERROR",
          `SCPI command template requires ${key}.`,
        );
      return String(value);
    },
  );
}

function requiredCommand(profile: ScpiProfile, key: string): string {
  const command = profile.commands[key];
  if (!command)
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      `SCPI profile ${profile.vendor} lacks ${key}.`,
    );
  return command;
}

function scpiResource(host: string, port: number): string {
  return `TCPIP0::${host}::${port}::SOCKET`;
}

function numberSetting(
  config: CaptureConfig,
  key: string,
  fallback: number,
): number {
  const value = config.settings?.[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InstrumentError(
      "CAPTURE_CONFIG_INVALID",
      `${key} must be numeric.`,
    );
  }
  return value;
}

function stringSetting(
  config: CaptureConfig,
  key: string,
  fallback: string,
): string {
  const value = config.settings?.[key] ?? fallback;
  if (typeof value !== "string")
    throw new InstrumentError("CAPTURE_CONFIG_INVALID", `${key} must be text.`);
  return value;
}

function captureConfiguration(
  config: CaptureConfig,
  profile: ScpiProfile,
): {
  channelConfigs: ScopeChannelConfig[];
  trigger: ScopeTrigger | null;
  triggerTimeoutMs: number;
  samples: number;
  setupCommands: string[];
  waveformQueries: Record<string, string>;
} {
  const channelConfigs = config.channels.map((index): ScopeChannelConfig => {
    const channel = `C${index + 1}`;
    const rangeV = numberSetting(config, `channel.${channel}.rangeV`, 5);
    const coupling = stringSetting(config, `channel.${channel}.coupling`, "dc");
    const attenuation = numberSetting(
      config,
      `channel.${channel}.attenuation`,
      1,
    );
    if (
      rangeV <= 0 ||
      (coupling !== "ac" && coupling !== "dc") ||
      attenuation <= 0
    ) {
      throw new InstrumentError(
        "CAPTURE_CONFIG_INVALID",
        `Channel ${channel} configuration is invalid.`,
      );
    }
    return { channel, rangeV, coupling, attenuation };
  });
  const triggerChannel = config.settings?.["trigger.channel"];
  let trigger: ScopeTrigger | null = null;
  if (triggerChannel !== undefined && triggerChannel !== null) {
    const channel = String(triggerChannel);
    const edge = stringSetting(config, "trigger.edge", "rising");
    const levelV = numberSetting(config, "trigger.levelV", 0);
    if (
      !channelConfigs.some((item) => item.channel === channel) ||
      (edge !== "rising" && edge !== "falling")
    ) {
      throw new InstrumentError(
        "CAPTURE_CONFIG_INVALID",
        "SCPI trigger configuration is invalid.",
      );
    }
    trigger = { channel, edge, levelV };
  }
  const triggerTimeoutMs = numberSetting(
    config,
    "trigger.timeoutMs",
    config.durationMs + 1_000,
  );
  const samples = Math.ceil((config.sampleRateHz * config.durationMs) / 1_000);
  if (
    !Number.isInteger(triggerTimeoutMs) ||
    triggerTimeoutMs < 1 ||
    samples > MAX_CAPTURE_SAMPLES
  ) {
    throw new InstrumentError(
      "CAPTURE_CONFIG_INVALID",
      "SCPI capture exceeds timeout or sample bounds.",
    );
  }
  const setupCommands = [requiredCommand(profile, "stop")];
  for (const channel of channelConfigs) {
    const values = {
      channel: channel.channel.slice(1),
      scaleV: channel.rangeV / 8,
      coupling: channel.coupling.toUpperCase(),
    };
    setupCommands.push(
      render(requiredCommand(profile, "channelDisplay"), values),
      render(requiredCommand(profile, "channelScale"), values),
      render(requiredCommand(profile, "channelCoupling"), values),
    );
  }
  setupCommands.push(
    render(requiredCommand(profile, "memoryDepth"), { samples }),
  );
  if (trigger) {
    const values = {
      channel: trigger.channel.slice(1),
      edge: trigger.edge === "rising" ? "POS" : "NEG",
      levelV: trigger.levelV,
    };
    setupCommands.push(
      render(requiredCommand(profile, "triggerType"), values),
      render(requiredCommand(profile, "triggerSlope"), values),
      render(requiredCommand(profile, "triggerLevel"), values),
    );
  }
  setupCommands.push(
    render(requiredCommand(profile, "waveformSource"), { samples }),
  );
  const waveformQueries = Object.fromEntries(
    channelConfigs.map((channel) => [
      channel.channel,
      render(requiredCommand(profile, "waveformQuery"), {
        channel: channel.channel.slice(1),
      }),
    ]),
  );
  return {
    channelConfigs,
    trigger,
    triggerTimeoutMs,
    samples,
    setupCommands,
    waveformQueries,
  };
}

function parsedChannelConfigs(value: unknown): ScopeChannelConfig[] {
  if (!Array.isArray(value)) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "SCPI channel metadata is malformed.",
    );
  }
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new InstrumentError(
        "INSTRUMENT_PROTOCOL_ERROR",
        "SCPI channel metadata is malformed.",
      );
    }
    const channel = Reflect.get(item, "channel");
    const rangeV = Reflect.get(item, "rangeV");
    const coupling = Reflect.get(item, "coupling");
    const attenuation = Reflect.get(item, "attenuation");
    if (
      typeof channel !== "string" ||
      typeof rangeV !== "number" ||
      (coupling !== "ac" && coupling !== "dc") ||
      typeof attenuation !== "number"
    ) {
      throw new InstrumentError(
        "INSTRUMENT_PROTOCOL_ERROR",
        "SCPI channel metadata is malformed.",
      );
    }
    return { channel, rangeV, coupling, attenuation };
  });
}

function parsedTrigger(value: unknown): ScopeTrigger | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "SCPI trigger metadata is malformed.",
    );
  }
  const channel = Reflect.get(value, "channel");
  const edge = Reflect.get(value, "edge");
  const levelV = Reflect.get(value, "levelV");
  if (
    typeof channel !== "string" ||
    (edge !== "rising" && edge !== "falling") ||
    typeof levelV !== "number"
  ) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "SCPI trigger metadata is malformed.",
    );
  }
  return { channel, edge, levelV };
}

async function artifactFromResponse(
  response: Record<string, unknown>,
  directory: string,
): Promise<ScopeCapture> {
  const path = response.path;
  const format = response.format;
  const durationMs = response.durationMs;
  const channels = response.channels;
  const channelConfigs = response.channelConfigs;
  const trigger = response.trigger;
  const sampleRateHz = response.sampleRateHz;
  const samples = response.samples;
  if (
    typeof path !== "string" ||
    typeof format !== "string" ||
    typeof durationMs !== "number" ||
    typeof channels !== "number" ||
    typeof sampleRateHz !== "number" ||
    typeof samples !== "number"
  ) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "SCPI capture metadata is malformed.",
    );
  }
  const root = await realpath(directory);
  const artifactPath = await realpath(resolve(path));
  const confined = relative(root, artifactPath);
  if (
    confined === ".." ||
    confined.startsWith(`..${sep}`) ||
    isAbsolute(confined)
  ) {
    throw new InstrumentError(
      "INSTRUMENT_PROTOCOL_ERROR",
      "SCPI artifact escaped its capture directory.",
    );
  }
  await access(artifactPath);
  return {
    path: artifactPath,
    format,
    durationMs,
    channels,
    channelConfigs: parsedChannelConfigs(channelConfigs),
    trigger: parsedTrigger(trigger),
    sampleRateHz,
    samples,
  };
}

function bridgeFailure(result: ProcessResult, action: string): never {
  const detail =
    result.stderr.trim().slice(0, 2_000) || `exit ${result.code ?? "unknown"}`;
  if (
    /VisaIOError|VI_ERROR_CONN_LOST|connection.*(?:reset|closed|lost)/iu.test(
      detail,
    )
  ) {
    throw new DeviceLostError(
      `SCPI scope connection was lost during ${action}.`,
      null,
    );
  }
  throw new InstrumentError(
    "INSTRUMENT_NOT_CONFIGURED",
    `SCPI ${action} failed: ${detail}`,
  );
}

export function createScpiScopeDriver(
  deps: ScpiScopeDriverDeps,
): InstrumentDriver {
  const runner = deps.runner ?? runInstrumentProcess;
  const prerequisites = deps.prerequisiteReport ?? defaultPrerequisites;
  const profiles = deps.profiles ?? [SIGLENT_SDS_PROFILE];
  const identified = new Map<string, ScpiProfile>();
  return {
    id: "scpi-lan-scope",
    async detect(transport) {
      const resolved = resolveInstrumentTransport(transport);
      if (resolved.kind === "usb")
        throw new TransportError(
          "TRANSPORT_NOT_IMPLEMENTED",
          "SCPI scope v1 requires LAN.",
        );
      const resource = scpiResource(resolved.host, resolved.port);
      const result = await runner(
        {
          command: "python3",
          args: ["-c", PYVISA_BRIDGE, "identify", JSON.stringify({ resource })],
          timeoutMs: 5_000,
          maxOutputBytes: MAX_BRIDGE_OUTPUT_BYTES,
        },
        new AbortController().signal,
      );
      if (result.code !== 0) return null;
      const idn = responseObject(result.stdout).idn;
      if (typeof idn !== "string")
        throw new InstrumentError(
          "INSTRUMENT_PROTOCOL_ERROR",
          "SCPI *IDN? response is malformed.",
        );
      const profile = profileForIdn(idn, profiles);
      if (!profile) return null;
      identified.set(resource, profile);
      return {
        kind: "scope",
        channels: 4,
        maxSampleRateHz: 2_000_000_000,
        features: [
          "capture:block",
          "trigger:edge",
          `dialect:${profile.vendor}`,
        ],
      };
    },
    async open(transport, claim, signal) {
      deps.verifyClaim(claim, claim.deviceId);
      signal.throwIfAborted();
      const resolved = resolveInstrumentTransport(transport);
      if (resolved.kind === "usb")
        throw new TransportError(
          "TRANSPORT_NOT_IMPLEMENTED",
          "SCPI scope v1 requires LAN.",
        );
      const resource = scpiResource(resolved.host, resolved.port);
      const registeredResource =
        deps.resourceForDeviceId?.(claim.deviceId)?.trim() || null;
      if (registeredResource === null || registeredResource !== resource) {
        throw new InstrumentError(
          "INSTRUMENT_NOT_FOUND",
          "SCPI claim is not bound by the registry to this PyVISA resource.",
        );
      }
      let profile = identified.get(resource) ?? null;
      if (!profile) {
        const result = await runner(
          {
            command: "python3",
            args: [
              "-c",
              PYVISA_BRIDGE,
              "identify",
              JSON.stringify({ resource }),
            ],
            timeoutMs: 5_000,
            maxOutputBytes: MAX_BRIDGE_OUTPUT_BYTES,
          },
          signal,
        );
        if (result.code !== 0) bridgeFailure(result, "identification");
        const idn = responseObject(result.stdout).idn;
        profile = typeof idn === "string" ? profileForIdn(idn, profiles) : null;
        if (!profile)
          throw new InstrumentError(
            "INSTRUMENT_NOT_FOUND",
            "SCPI scope dialect is unsupported.",
          );
        identified.set(resource, profile);
      }
      const capabilities: InstrumentCapabilities = {
        kind: "scope",
        channels: 4,
        maxSampleRateHz: 2_000_000_000,
        features: [
          "capture:block",
          "trigger:edge",
          `dialect:${profile.vendor}`,
        ],
      };
      let closed = false;
      let released = false;
      const release = () => {
        closed = true;
        if (!released) {
          released = true;
          deps.releaseClaim?.(claim);
        }
      };
      signal.addEventListener("abort", release, { once: true });
      return {
        deviceId: claim.deviceId,
        capabilities,
        async capture(config, captureSignal) {
          if (closed)
            throw new InstrumentError(
              "SESSION_CLOSED",
              "SCPI scope session is closed.",
            );
          validateCaptureConfig(config, capabilities, MAX_CAPTURE_MS);
          deps.verifyClaim(claim, claim.deviceId);
          const armed = captureConfiguration(config, profile);
          captureSignal.throwIfAborted();
          await mkdir(config.artifactSink.directory, { recursive: true });
          try {
            const result = await runner(
              {
                command: "python3",
                args: [
                  "-c",
                  PYVISA_BRIDGE,
                  "capture",
                  JSON.stringify({
                    resource,
                    outputDirectory: config.artifactSink.directory,
                    durationMs: config.durationMs,
                    sampleRateHz: config.sampleRateHz,
                    ...armed,
                    armCommand: requiredCommand(profile, "arm"),
                    stopCommand: requiredCommand(profile, "stop"),
                    triggerStatusCommand: requiredCommand(
                      profile,
                      "triggerStatus",
                    ),
                  }),
                ],
                timeoutMs: armed.triggerTimeoutMs + 15_000,
                maxOutputBytes: MAX_BRIDGE_OUTPUT_BYTES,
              },
              captureSignal,
            );
            if (result.code === 42 && armed.trigger !== null) {
              throw new ScopeTriggerTimeoutError(
                "The armed SCPI edge did not occur before the deadline.",
                {
                  channelConfigs: armed.channelConfigs,
                  trigger: armed.trigger,
                  sampleRateHz: config.sampleRateHz,
                  samples: armed.samples,
                },
              );
            }
            if (result.code !== 0) bridgeFailure(result, "capture");
            const artifact = await artifactFromResponse(
              responseObject(result.stdout),
              config.artifactSink.directory,
            );
            await config.artifactSink.record(artifact);
            return artifact;
          } catch (error) {
            if (!(error instanceof ScopeTriggerTimeoutError)) release();
            throw error;
          } finally {
            if (captureSignal.aborted) release();
          }
        },
        async close() {
          signal.removeEventListener("abort", release);
          release();
        },
      };
    },
    prerequisites,
  };
}
