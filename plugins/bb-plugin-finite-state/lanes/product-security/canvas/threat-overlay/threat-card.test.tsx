// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@bb/plugin-sdk/testing/app";

beforeAll(() => installTestPluginRuntime());
afterEach(() => cleanup());

function threatResult(id: string) {
  return {
    projectId: "project-1",
    projectVersionId: null,
    kind: "threat",
    key: id,
    label: "Unsigned boot path",
    fields: {
      slug: id,
      name: "Unsigned boot path",
      category: "spoofing",
      severity: "high",
      description: "Bootloader accepts unsigned images.",
      affected_components: ["COMP-boot"],
      mitigations: ["MIT-secure-boot"],
    },
    links: [],
    cache: {
      state: "fresh" as const,
      asOf: "2026-08-15T00:00:00.000Z",
      message: null,
      acceptedGenerationId: "gen-1",
      baseRevision: 1,
    },
  };
}

describe("ThreatCard", () => {
  it("self-fetches by slug via taraGet", async () => {
    const { ThreatCard } = await import("./ThreatCard.js");
    const slot = renderSlot(
      { component: () => <ThreatCard id="THREAT-22" /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: { taraGet: () => threatResult("THREAT-22") },
      },
    );
    expect(await slot.findByLabelText("Threat THREAT-22")).toBeTruthy();
    expect(slot.getByText("Unsigned boot path")).toBeTruthy();
    expect(slot.getByText("spoofing")).toBeTruthy();
    expect(slot.getByText("high")).toBeTruthy();
    expect(slot.getByText("COMP-boot")).toBeTruthy();
    expect(slot.inspection.rpcCalls[0]).toMatchObject({
      method: "taraGet",
      input: { kind: "threat", id: "THREAT-22" },
    });
  });

  it("rejects an invalid slug before RPC", async () => {
    const { ThreatCard } = await import("./ThreatCard.js");
    const slot = renderSlot(
      { component: () => <ThreatCard id="../etc/passwd" /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: { taraGet: () => threatResult("unused") },
      },
    );
    expect(await slot.findByText("Invalid threat identity")).toBeTruthy();
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });

  it("renders missing/error states and opens the threat focus route", async () => {
    const { ThreatCard } = await import("./ThreatCard.js");
    const missing = renderSlot(
      { component: () => <ThreatCard id="THREAT-missing" /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: {
          taraGet: () => Promise.reject(new Error("TARA_ENTITY_NOT_FOUND")),
        },
      },
    );
    expect(await missing.findByText("Threat not found")).toBeTruthy();

    const ready = renderSlot(
      { component: () => <ThreatCard id="THREAT-22" /> },
      {},
      {
        context: { projectId: "project-1" },
        rpc: { taraGet: () => threatResult("THREAT-22") },
      },
    );
    fireEvent.click(await ready.findByRole("button", { name: "Open threat" }));
    expect(ready.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({
        method: "toPluginPanel",
        path: "product-security",
        options: { subPath: "tara/threats/THREAT-22" },
      }),
    );
  });
});
