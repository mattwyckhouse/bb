import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  HardwareRateLimitError,
  rateLimit,
  type RateLimitDeps,
} from "./rate-limit.js";

const databases: Database.Database[] = [];

function fixture(sessionId = "session-a") {
  const db = new Database(":memory:");
  databases.push(db);
  let current = new Date("2026-08-13T12:00:00.000Z");
  const deps: RateLimitDeps = {
    db,
    sessionId,
    now: () => current,
    rateLimitPolicy: {
      device: { capacity: 2, refillPerSecond: 1 },
      session: { capacity: 3, refillPerSecond: 1 },
    },
  };
  return {
    deps,
    advance(ms: number) { current = new Date(current.getTime() + ms); },
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
describe("hardware rate policy", () => {
  it("bursts, returns a typed retry horizon, and refills", async () => {
    const fx = fixture();
    const throttle = rateLimit(fx.deps, "device-a");
    const signal = new AbortController().signal;
    await throttle.acquire(signal);
    await throttle.acquire(signal);
    await expect(throttle.acquire(signal)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 1_000,
      retryAt: "2026-08-13T12:00:01.000Z",
    });
    fx.advance(1_000);
    await expect(throttle.acquire(signal)).resolves.toBeUndefined();
  });

  it("isolates device buckets while enforcing the shared session bucket", async () => {
    const fx = fixture();
    const signal = new AbortController().signal;
    const first = rateLimit(fx.deps, "device-a");
    const second = rateLimit(fx.deps, "device-b");
    await first.acquire(signal);
    await first.acquire(signal);
    await second.acquire(signal);
    await expect(second.acquire(signal)).rejects.toBeInstanceOf(HardwareRateLimitError);

    const otherSession = fixture("session-b");
    await expect(rateLimit(otherSession.deps, "device-a").acquire(signal)).resolves.toBeUndefined();
  });
});
