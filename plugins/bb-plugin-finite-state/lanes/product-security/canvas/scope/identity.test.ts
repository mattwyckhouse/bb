import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { REPO_LOCAL_PROJECT_ID_PREFIX } from "../../../../lib/contract-load/projection-key.js";
import { createPluginContext } from "../../../../lib/context.js";
import {
  assertWorkspacePlatformProjectBinding,
  workspacePlatformProjectIsBound,
} from "./identity.js";

describe("workspace platform project binding identity", () => {
  it("treats repo-local scopes as inherent without a Sync binding row", () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tara-repo-local-identity",
    });
    const db = createPluginContext(bb).db();
    const repoLocalProjectId = `${REPO_LOCAL_PROJECT_ID_PREFIX}digest`;

    expect(
      workspacePlatformProjectIsBound(
        db,
        "workspace-offline",
        repoLocalProjectId,
      ),
    ).toBe(true);
    expect(() =>
      assertWorkspacePlatformProjectBinding(
        db,
        "workspace-offline",
        repoLocalProjectId,
      ),
    ).not.toThrow();

    expect(
      workspacePlatformProjectIsBound(
        db,
        "workspace-offline",
        "platform-project",
      ),
    ).toBe(false);
    expect(() =>
      assertWorkspacePlatformProjectBinding(
        db,
        "workspace-offline",
        "platform-project",
      ),
    ).toThrow(/Open Sync and select the project/u);

    void harness.lifecycle.dispose();
  });
});
