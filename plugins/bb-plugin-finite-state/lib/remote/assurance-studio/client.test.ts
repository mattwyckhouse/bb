import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { diagnoseRemoteFailure } from "../errors.js";
import { RemoteError, type AsEntity } from "../types.js";
import { AssuranceStudioClient } from "./client.js";

const errorEnvelopeRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../test/mock-remote/as-error-envelopes",
);

function loadErrorEnvelope(name: string): unknown {
  return JSON.parse(readFileSync(join(errorEnvelopeRoot, name), "utf8"));
}

describe("AssuranceStudioClient review regressions", () => {
  it("treats an X-API-Key scheme mismatch as an immediate auth failure", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        return headers.has("Authorization") ||
          headers.get("X-API-Key") !== "expected-as-key"
          ? Response.json({ error: "unauthorized" }, { status: 401 })
          : Response.json(
              { error: "forced scheme-mismatch fixture" },
              { status: 401 },
            );
      },
    );
    const client = new AssuranceStudioClient({
      baseUrl: "https://fs-alpha.finitestate.io",
      apiKey: "expected-as-key",
      fetch,
    });

    await expect(client.health()).rejects.toMatchObject({
      code: "REMOTE_HTTP_401",
      retryable: false,
      message:
        "Assurance Studio authentication failed for GET https://fs-alpha.finitestate.io/api/projects?page=1&limit=1 with HTTP 401 using X-API-Key. Refresh Assurance Studio API key (asApiKey).",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-API-Key")).toBe("expected-as-key");
    expect(headers.has("Authorization")).toBe(false);
  });

  it("advances upstream page numbers across short nonterminal pages", async () => {
    const requestedPages: number[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      const first = (page - 1) * 30;
      return Response.json({
        success: true,
        data: {
          threats: Array.from({ length: 30 }, (_, index) => ({
            id: `threat-${first + index}`,
            project_id: "project-1",
          })),
          total: 120,
          has_more: page < 4,
        },
      });
    });
    const client = new AssuranceStudioClient({
      baseUrl: "https://as.example",
      apiKey: "as-secret",
      fetch,
    });

    const firstIterator = client
      .listEntities("threat", {
        projectId: "project-1",
        page: { pageSize: 50 },
      })
      [Symbol.asyncIterator]();
    const first = await firstIterator.next();
    expect(first.value?.items).toHaveLength(30);
    expect(first.value?.next).toEqual(expect.any(String));

    const ids = first.value?.items.map((item: AsEntity) => item.id) ?? [];
    for await (const page of client.listEntities("threat", {
      projectId: "project-1",
      page: { continuation: first.value?.next ?? "" },
    })) {
      ids.push(...page.items.map((item) => item.id));
    }
    expect(requestedPages).toEqual([1, 1, 2, 3, 4]);
    expect(ids).toHaveLength(120);
    expect(new Set(ids)).toHaveLength(120);
    expect(ids.at(-1)).toBe("threat-119");
  });

  it("preserves a successful create when the review-status PATCH fails", async () => {
    const bodies: unknown[] = [];
    const methods: string[] = [];
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        if (method === "POST")
          return Response.json({
            success: true,
            data: {
              id: "threat-1",
              project_id: "project-1",
              review_version: "9007199254740993",
              review_status: "pending",
            },
          });
        if (method === "PATCH")
          return Response.json(
            { error: "review update failed" },
            {
              status: 500,
            },
          );
        return Response.json({
          success: true,
          data: {
            id: "threat-1",
            project_id: "project-1",
            review_version: "9007199254740993",
            review_status: "pending",
          },
        });
      },
    );
    const client = new AssuranceStudioClient({
      baseUrl: "https://as.example",
      apiKey: "as-secret",
      fetch,
    });

    await expect(
      client.createEntity("threat", {
        projectId: "project-1",
        fields: { name: "Threat", review_status: "human_approved" },
      }),
    ).resolves.toMatchObject({
      success: true,
      entity: { id: "threat-1", reviewStatus: "pending" },
      reviewStatusSet: false,
      reviewStatusReason:
        "Review status PATCH failed after the entity was created",
    });
    expect(methods).toEqual(["POST", "PATCH", "GET"]);
    expect(bodies).toEqual([
      { name: "Threat" },
      { review_status: "human_approved", review_version: "9007199254740993" },
    ]);
  });

  it("maps lossless DataFlow PATCH aliases and requires review concurrency", async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        return Response.json({
          success: true,
          data: {
            id: "flow-1",
            project_id: "project-1",
            review_version: "9007199254740994",
          },
        });
      },
    );
    const client = new AssuranceStudioClient({
      baseUrl: "https://as.example",
      apiKey: "as-secret",
      fetch,
    });

    await expect(
      client.updateEntity("dataflow", {
        projectId: "project-1",
        id: "flow-1",
        fields: {
          source_component_id: "component-a",
          target_component_id: "component-b",
          is_encrypted: true,
          is_authenticated: false,
          reviewVersion: "9007199254740993",
        },
      }),
    ).resolves.toMatchObject({ success: true, entity: { id: "flow-1" } });
    expect(bodies).toEqual([
      {
        from_component: "component-a",
        to_component: "component-b",
        encrypted: true,
        authenticated: false,
        review_version: "9007199254740993",
      },
    ]);

    await expect(
      client.updateEntity("threat", {
        projectId: "project-1",
        id: "threat-1",
        fields: { description: "unsafe without a concurrency token" },
      }),
    ).rejects.toMatchObject({ code: "AS_REVIEW_VERSION_REQUIRED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps strict AS request-key rejection visible", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: "Unrecognized key",
          field: "unexpected_field",
        },
        { status: 400 },
      ),
    );
    const client = new AssuranceStudioClient({
      baseUrl: "https://as.example",
      apiKey: "as-secret",
      fetch,
    });

    await expect(
      client.createEntity("threat", {
        projectId: "project-1",
        fields: { name: "Threat", unexpected_field: true },
      }),
    ).rejects.toMatchObject({
      service: "assurance-studio",
      code: "REMOTE_HTTP_400",
      status: 400,
      details: {
        error: "Unrecognized key",
        field: "unexpected_field",
        request: expect.objectContaining({
          method: "POST",
          url: "https://as.example/api/projects/project-1/threats",
        }),
      },
    });
  });
});

describe("AssuranceStudioClient HTTP-200 error envelopes (FS-211)", () => {
  it("refuses captured threat error envelopes without coercing to an empty page", async () => {
    // Capture: a97db111-98ae-46c0-a1f2-9868c93ae51b--threats.json
    // (identical twin: c7e5307b-34b6-4979-b3a1-eb2274890781--threats.json)
    const body = loadErrorEnvelope("threats-failed.json");
    expect(body).toEqual({ error: "Failed to fetch threats" });
    const fetch = vi.fn(async () => Response.json(body, { status: 200 }));
    const client = new AssuranceStudioClient({
      baseUrl: "https://as.example",
      apiKey: "as-secret",
      fetch,
    });

    const iterator = client
      .listEntities("threat", { projectId: "project-error" })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "AS_REMOTE_REPORTED_ERROR",
      status: 200,
      retryable: false,
      message: "Assurance Studio reported an error: Failed to fetch threats",
      details: { error: "Failed to fetch threats" },
    });
  });

  it("classifies captured threat/requirements error envelopes as http, never unreachable or auth", async () => {
    const cases = [
      {
        fixture: "threats-failed.json",
        kind: "threat" as const,
        // Capture: a97db111-98ae-46c0-a1f2-9868c93ae51b--threats.json
        message: "Assurance Studio reported an error: Failed to fetch threats",
        details: { error: "Failed to fetch threats" },
      },
      {
        fixture: "requirements-bad-request.json",
        kind: "requirement" as const,
        // Capture: 54a35838-465a-4d22-8f8b-36a1e25237c5--requirements.json
        message:
          "Assurance Studio reported an error: Failed to fetch requirements: Bad Request",
        details: {
          error: "Failed to fetch requirements",
          details: "Bad Request",
        },
      },
      {
        fixture: "requirements-414-cloudflare.json",
        kind: "requirement" as const,
        // Capture: c7e5307b-34b6-4979-b3a1-eb2274890781--requirements.json
        messageIncludes: "414 Request-URI Too Large",
        detailsError: "Failed to fetch requirements",
      },
    ] as const;

    for (const entry of cases) {
      const body = loadErrorEnvelope(entry.fixture);
      const fetch = vi.fn(async () => Response.json(body, { status: 200 }));
      const client = new AssuranceStudioClient({
        baseUrl: "https://as.example",
        apiKey: "as-secret",
        fetch,
      });
      let thrown: unknown;
      try {
        for await (const _page of client.listEntities(entry.kind, {
          projectId: "project-error",
        })) {
          throw new Error("error envelope must not yield pages");
        }
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RemoteError);
      expect(thrown).toMatchObject({
        code: "AS_REMOTE_REPORTED_ERROR",
        status: 200,
        retryable: false,
      });
      if ("message" in entry) {
        expect(thrown).toMatchObject({
          message: entry.message,
          details: entry.details,
        });
      } else {
        expect(String((thrown as RemoteError).message)).toContain(
          entry.messageIncludes,
        );
        expect(thrown).toMatchObject({
          details: { error: entry.detailsError },
        });
      }
      const diagnostic = diagnoseRemoteFailure(thrown);
      expect(diagnostic.kind).toBe("http");
      expect(diagnostic.status).toBe(200);
      expect(diagnostic.message).toContain("Failed to fetch");
      expect(diagnostic.credential).toBeNull();
      client.close();
    }
  });

  it("still drains successful per-kind envelopes after an error-envelope sibling fails", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/threats")) {
        return Response.json(loadErrorEnvelope("threats-failed.json"), {
          status: 200,
        });
      }
      // Live requirements success shape: data.requirements (FS-207 corpus).
      return Response.json({
        success: true,
        data: {
          requirements: [
            {
              id: "req-1",
              project_id: "project-mixed",
              requirement_id: "REQ-1",
            },
          ],
          total: 1,
        },
      });
    });
    const client = new AssuranceStudioClient({
      baseUrl: "https://as.example",
      apiKey: "as-secret",
      fetch,
    });

    await expect(
      client
        .listEntities("threat", { projectId: "project-mixed" })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toMatchObject({ code: "AS_REMOTE_REPORTED_ERROR", status: 200 });

    const requirements: AsEntity[] = [];
    for await (const page of client.listEntities("requirement", {
      projectId: "project-mixed",
    })) {
      requirements.push(...page.items);
    }
    expect(requirements).toEqual([
      expect.objectContaining({ id: "req-1", kind: "requirement" }),
    ]);
  });
});
