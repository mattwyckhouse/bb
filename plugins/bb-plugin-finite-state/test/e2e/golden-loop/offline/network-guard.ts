import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { resolve } from "node:path";

export interface NetworkViolation {
  beat: string | null;
  primitive:
    | "dgram"
    | "dns"
    | "fetch"
    | "http"
    | "http2"
    | "https"
    | "socket"
    | "tls";
  target: string;
  caller: string;
}

export class UndeclaredNetworkError extends Error {
  constructor(readonly violation: NetworkViolation) {
    super(
      `OFFLINE_NETWORK_VIOLATION beat=${violation.beat ?? "setup"} primitive=${violation.primitive} target=${violation.target} caller=${violation.caller}`,
    );
    this.name = "UndeclaredNetworkError";
  }
}

export interface OfflineNetworkGuardOptions {
  allowedLoopbackPorts?: readonly number[];
  allowedSocketPaths?: readonly string[];
  onViolation?(violation: NetworkViolation): void;
}

type Target = Readonly<{
  host: string | null;
  port: number | null;
  path: string | null;
}>;

function callerFromStack(): string {
  return (
    new Error().stack
      ?.split("\n")
      .slice(3)
      .find(
        (line) =>
          !line.includes("offline/network-guard") &&
          !line.includes("node:internal"),
      )
      ?.trim() ?? "unknown caller"
  ).replaceAll(process.cwd(), ".");
}

function socketTarget(args: readonly unknown[]): Target {
  const first = args[0];
  if (typeof first === "number") {
    return {
      host: typeof args[1] === "string" ? args[1] : "localhost",
      port: first,
      path: null,
    };
  }
  if (typeof first === "string") {
    return { host: null, port: null, path: first };
  }
  if (first !== null && typeof first === "object") {
    const options = first as Readonly<Record<string, unknown>>;
    const port = options["port"];
    return {
      host:
        typeof options["host"] === "string"
          ? options["host"]
          : typeof options["hostname"] === "string"
            ? options["hostname"]
            : "localhost",
      port:
        typeof port === "number"
          ? port
          : typeof port === "string"
            ? Number(port)
            : null,
      path: typeof options["path"] === "string" ? options["path"] : null,
    };
  }
  return { host: null, port: null, path: null };
}

function requestTarget(args: readonly unknown[], secure: boolean): Target {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) {
    const url = new URL(first.toString());
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      path: null,
    };
  }
  const target = socketTarget(args);
  return { ...target, port: target.port ?? (secure ? 443 : 80) };
}

function datagramSendTarget(args: readonly unknown[]): Target | null {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const host = args[index];
    if (typeof host !== "string") continue;
    const port = args[index - 1];
    if (typeof port === "number") {
      return { host, port, path: null };
    }
  }
  return null;
}

export class OfflineNetworkGuard {
  readonly violations: NetworkViolation[] = [];
  private readonly ports: ReadonlySet<number>;
  private readonly socketPaths: ReadonlySet<string>;
  private readonly restores: Array<() => void> = [];
  private beat: string | null = null;

  constructor(private readonly options: OfflineNetworkGuardOptions = {}) {
    this.ports = new Set(options.allowedLoopbackPorts ?? []);
    this.socketPaths = new Set(
      (options.allowedSocketPaths ?? []).map((path) => resolve(path)),
    );
  }

  setBeat(beat: string | number | null): void {
    this.beat = beat === null ? null : String(beat);
  }

  assertMcpEndpoint(endpoint: string | URL): void {
    const url = new URL(endpoint);
    this.authorize("fetch", {
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      path: null,
    });
  }

  private authorize(primitive: NetworkViolation["primitive"], target: Target) {
    if (target.path !== null && this.socketPaths.has(resolve(target.path))) {
      return;
    }
    const host = target.host?.replace(/^\[|\]$/gu, "").toLowerCase() ?? null;
    const loopback =
      host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (loopback && target.port !== null && this.ports.has(target.port)) return;
    const violation: NetworkViolation = {
      beat: this.beat,
      primitive,
      target: target.path ?? `${host ?? "unknown"}:${target.port ?? "unknown"}`,
      caller: callerFromStack(),
    };
    this.violations.push(violation);
    this.options.onViolation?.(violation);
    throw new UndeclaredNetworkError(violation);
  }

  private replace(object: object, key: PropertyKey, replacement: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) {
      throw new Error(`Cannot guard missing network primitive ${String(key)}`);
    }
    Object.defineProperty(object, key, { ...descriptor, value: replacement });
    this.restores.push(() => Object.defineProperty(object, key, descriptor));
  }

  install(): void {
    if (this.restores.length > 0) return;
    const originalFetch = globalThis.fetch;
    this.replace(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        this.authorize("fetch", {
          host: url.hostname,
          port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          path: null,
        });
        return originalFetch(input, init);
      },
    );

    for (const key of ["connect", "createConnection"] as const) {
      const original = net[key];
      this.replace(net, key, (...args: unknown[]) => {
        this.authorize("socket", socketTarget(args));
        return Reflect.apply(original, net, args);
      });
    }
    const guard = this;
    const originalSocketConnect = net.Socket.prototype.connect;
    this.replace(net.Socket.prototype, "connect", function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      guard.authorize("socket", socketTarget(args));
      return Reflect.apply(originalSocketConnect, this, args);
    });
    const originalTlsConnect = tls.connect;
    this.replace(tls, "connect", (...args: unknown[]) => {
      this.authorize("tls", socketTarget(args));
      return Reflect.apply(originalTlsConnect, tls, args);
    });

    for (const [object, key, secure, primitive] of [
      [http, "request", false, "http"],
      [http, "get", false, "http"],
      [https, "request", true, "https"],
      [https, "get", true, "https"],
    ] as const) {
      const original = object[key];
      this.replace(object, key, (...args: unknown[]) => {
        this.authorize(primitive, requestTarget(args, secure));
        return Reflect.apply(original, object, args);
      });
    }

    const originalHttp2Connect = http2.connect;
    this.replace(http2, "connect", (...args: unknown[]) => {
      this.authorize("http2", requestTarget(args, true));
      return Reflect.apply(originalHttp2Connect, http2, args);
    });

    const originalCreateSocket = dgram.createSocket;
    this.replace(dgram, "createSocket", (...args: unknown[]) => {
      const socket = Reflect.apply(originalCreateSocket, dgram, args);
      const originalConnect = socket.connect;
      Object.defineProperty(socket, "connect", {
        configurable: true,
        value: (...connectArgs: unknown[]) => {
          this.authorize("dgram", socketTarget(connectArgs));
          return Reflect.apply(originalConnect, socket, connectArgs);
        },
      });
      const originalSend = socket.send;
      Object.defineProperty(socket, "send", {
        configurable: true,
        value: (...sendArgs: unknown[]) => {
          const target = datagramSendTarget(sendArgs);
          if (target !== null) this.authorize("dgram", target);
          return Reflect.apply(originalSend, socket, sendArgs);
        },
      });
      return socket;
    });

    for (const key of ["lookup", "resolve"] as const) {
      const original = dns[key];
      this.replace(dns, key, (...args: unknown[]) => {
        const hostname =
          typeof args[0] === "string" ? args[0].toLowerCase() : "unknown";
        if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
          this.authorize("dns", { host: hostname, port: 53, path: null });
        }
        return Reflect.apply(original, dns, args);
      });
    }
    for (const key of ["lookup", "resolve"] as const) {
      const original = dnsPromises[key];
      this.replace(dnsPromises, key, (...args: unknown[]) => {
        const hostname =
          typeof args[0] === "string" ? args[0].toLowerCase() : "unknown";
        if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
          this.authorize("dns", { host: hostname, port: 53, path: null });
        }
        return Reflect.apply(original, dnsPromises, args);
      });
    }
  }

  restore(): void {
    for (const restore of this.restores.reverse()) restore();
    this.restores.length = 0;
  }

  assertClean(): void {
    if (this.violations[0])
      throw new UndeclaredNetworkError(this.violations[0]);
  }
}

export async function withOfflineNetworkGuard<T>(
  beat: string | number,
  operation: () => Promise<T> | T,
  options: OfflineNetworkGuardOptions = {},
): Promise<T> {
  const guard = new OfflineNetworkGuard(options);
  guard.setBeat(beat);
  guard.install();
  try {
    return await operation();
  } finally {
    guard.restore();
  }
}
