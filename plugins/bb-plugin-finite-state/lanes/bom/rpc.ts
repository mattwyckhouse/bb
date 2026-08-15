import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";

import { rpcContract } from "../../shared/contract.js";

const cachedProjectVersionsRpc = {
  input: z.object({ projectId: z.string().min(1).max(512) }).strict(),
  output: z
    .object({
      versions: z.array(
        z
          .object({
            platformProjectId: z.string().min(1).max(512),
            platformProjectName: z.string().min(1).max(512).nullable(),
            projectVersionId: z.string().min(1).max(512),
            projectVersionName: z.string().min(1).max(512).nullable(),
            asOf: z.string().nullable(),
            state: z.enum(["fresh", "stale"]),
          })
          .strict(),
      ),
      selectedPlatformProjectId: z.string().min(1).max(512).nullable(),
      selectedProjectVersionId: z.string().min(1).max(512).nullable(),
    })
    .strict(),
} as const;

const platformScopeNamesRpc = {
  input: z
    .object({
      scopes: z
        .array(
          z
            .object({
              projectId: z.string().min(1).max(512),
              projectVersionId: z.string().min(1).max(512),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  output: z
    .object({
      scopes: z.array(
        z
          .object({
            projectId: z.string().min(1).max(512),
            projectName: z.string().min(1).max(512).nullable(),
            projectVersionId: z.string().min(1).max(512),
            projectVersionName: z.string().min(1).max(512).nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
} as const;

// This copies WP-24's discovery shape under BOM ownership. No findings-lane
// source or handler is imported across the lane boundary.
export const bomCachedVersionsContract = defineRpcContract({
  bomCachedProjectVersions: cachedProjectVersionsRpc,
  bomPlatformScopeNames: platformScopeNamesRpc,
});

export const bomAppRpcContract = defineRpcContract({
  bomSoftwareList: rpcContract.bomSoftwareList,
  bomComponentGet: rpcContract.bomComponentGet,
  syncPull: rpcContract.syncPull,
  bomCachedProjectVersions: cachedProjectVersionsRpc,
  bomPlatformScopeNames: platformScopeNamesRpc,
});
