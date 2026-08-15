import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";

import { createPluginContext } from "../../../lib/context.js";
import { registerFiniteStateCli } from "./register.js";
import {
  CANONICAL_COMMANDS,
  FINITE_STATE_COMMAND,
  HBOM_ACCEPT_SUMMARY,
  PUSH_SUMMARY,
  renderPluginCommandsSkillFromMetadata,
  withContributedSubtrees,
} from "./metadata.js";

const hosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

describe("finite-state CLI metadata", () => {
  it("snapshots canonical commands, summaries, aliases, and flags", () => {
    const names = CANONICAL_COMMANDS.map((command) => command.name);
    expect(names).toEqual([
      "connect",
      "connections",
      "project",
      "as-projects",
      "as-project-select",
      "seed",
      "pull",
      "status",
      "plan",
      "push",
      "triage",
      "tara",
      "req",
      "ears",
      "verify",
      "bom",
      "firmware",
      "bench",
      "doc",
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(FINITE_STATE_COMMAND.name).toBe("finite-state");
    expect(FINITE_STATE_COMMAND.summary).toContain("reviewable sync plans");
    expect(PUSH_SUMMARY).toContain("does not push upstream");
    expect(PUSH_SUMMARY).toContain("is not an agent tool");
    expect(HBOM_ACCEPT_SUMMARY).toContain("does not accept or reject");
    const push = CANONICAL_COMMANDS.find((command) => command.name === "push");
    expect(push?.summary).toBe(PUSH_SUMMARY);
    expect(push?.usage).toContain("There is no --yes flag");
    const triage = CANONICAL_COMMANDS.find(
      (command) => command.name === "triage",
    );
    expect(triage?.usage).toContain("triage pull|status|plan|push");
    expect(triage?.usage).toContain("--help");
    expect(triage?.usage).not.toContain("--yes");
    expect(triage?.usage).not.toContain("--overwrite");
    const bom = CANONICAL_COMMANDS.find((command) => command.name === "bom");
    expect(bom?.usage).toContain("bom hbom accept");
    expect(bom?.usage).toContain("bom hbom reject");
    expect(bom?.summary).toContain("never resolve");
    const bench = CANONICAL_COMMANDS.find(
      (command) => command.name === "bench",
    );
    expect(bench?.usage).toContain("bench run <pv_id>");
    expect(bench?.usage).toContain("[--target path]");
    const contributed = withContributedSubtrees([
      {
        name: "hw",
        summary: "Future hardware subtree contribution.",
        usage: "hw discover",
      },
      {
        name: "fw",
        summary: "Future firmware-lab subtree contribution.",
        usage: "fw devices",
      },
    ]);
    expect(contributed.map((command) => command.name)).toContain("hw");
    expect(contributed.map((command) => command.name)).toContain("fw");
  });

  it("can generate plugin-commands skill without running plugin code", () => {
    const skill = renderPluginCommandsSkillFromMetadata();
    expect(skill).toContain("## bb finite-state");
    expect(skill).toContain("Contributed by plugin `finite-state`");
    for (const command of CANONICAL_COMMANDS) {
      expect(skill).toContain(`\`${command.usage}\``);
      expect(skill).toContain(command.summary);
    }
    expect(skill).toContain(PUSH_SUMMARY);
  });

  it("rejects reserved names and duplicate contributed commands", () => {
    const host = createFakePluginHost({
      pluginId: `fs-cli-meta-${crypto.randomUUID()}`,
    });
    hosts.push(host);
    expect(() =>
      host.bb.cli.register({
        name: "plugin",
        summary: "reserved",
        commands: [],
        run: () => ({ exitCode: 0 }),
      }),
    ).toThrow(/reserved by the bb CLI/);
    expect(() =>
      withContributedSubtrees([
        { name: "connect", summary: "dup", usage: "connect" },
      ]),
    ).toThrow(/duplicate finite-state CLI command "connect"/);
    const ctx = createPluginContext(host.bb);
    registerFiniteStateCli(host.bb, ctx);
    expect(() =>
      host.bb.cli.register({
        name: "finite-state",
        summary: "again",
        commands: [],
        run: () => ({ exitCode: 0 }),
      }),
    ).toThrow(/already registered/);
    registerFiniteStateCli(host.bb, ctx);
    expect(host.harness.registrations.cli?.name).toBe("finite-state");
    expect(
      host.harness.registrations.cli?.commands.map((command) => command.name),
    ).toEqual(CANONICAL_COMMANDS.map((command) => command.name));
  });
});
