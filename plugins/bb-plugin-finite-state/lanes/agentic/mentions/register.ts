import type { BbPluginApi, PluginMentionTrigger } from "@bb/plugin-sdk";

import type { PluginContext } from "../../../lib/context.js";
import {
  searchProvider,
  type MentionProviderId,
  type MentionSearchHooks,
} from "./search.js";
import { resolveProvider, type MentionResolveHooks } from "./resolve.js";

export type { MentionProviderId, MentionScope } from "./search.js";

export const MENTION_PROVIDERS = [
  {
    id: "fs-model",
    label: "Finite State model",
    triggers: ["@"] as const satisfies readonly PluginMentionTrigger[],
  },
  {
    id: "fs-docs",
    label: "Finite State documents",
    triggers: ["@"] as const satisfies readonly PluginMentionTrigger[],
  },
  {
    id: "fs-intel",
    label: "Finite State intelligence",
    triggers: ["#"] as const satisfies readonly PluginMentionTrigger[],
  },
  {
    id: "fs-runs",
    label: "Finite State runs",
    triggers: ["~"] as const satisfies readonly PluginMentionTrigger[],
  },
] as const;

export interface MentionIndex {
  search(
    provider: MentionProviderId,
    query: string,
    signal: AbortSignal,
  ): Promise<import("@bb/plugin-sdk").PluginMentionItem[]>;
  resolve(
    provider: MentionProviderId,
    itemId: string,
  ): Promise<{ context: string }>;
}

export interface CreateMentionIndexOptions {
  ctx: PluginContext;
  projectId?: string | null;
  search?: MentionSearchHooks;
  resolve?: MentionResolveHooks;
}

/**
 * Test/SDK-facing index over the four Finite State mention providers.
 * Composer registration uses the same search/resolve implementations.
 */
export function createMentionIndex(
  options: CreateMentionIndexOptions,
): MentionIndex {
  const { ctx } = options;
  const projectId = options.projectId ?? null;
  return {
    async search(provider, query, signal) {
      if (signal.aborted) return [];
      return searchProvider(
        provider,
        ctx.db(),
        projectId,
        query,
        options.search,
        ctx.log,
      );
    },
    async resolve(provider, itemId) {
      return resolveProvider(
        provider,
        ctx.db(),
        projectId,
        itemId,
        options.resolve,
        ctx.log,
      );
    },
  };
}

/**
 * Register the four SPEC 06 §2.3 mention providers once per factory execution.
 * Search is deadline-bound and failure-isolated; resolve never throws.
 */
export function registerMentions(bb: BbPluginApi, ctx: PluginContext): void {
  for (const provider of MENTION_PROVIDERS) {
    const id = provider.id;
    bb.ui.registerMentionProvider({
      id,
      label: provider.label,
      triggers: [...provider.triggers],
      async search(searchCtx) {
        try {
          if (searchCtx.projectId) {
            await bb.storage.kv.set(
              "finite-state:last-mention-project",
              searchCtx.projectId,
            );
          }
          return await searchProvider(
            id,
            ctx.db(),
            searchCtx.projectId,
            searchCtx.query,
            {},
            ctx.log,
          );
        } catch (error) {
          ctx.log.warn(
            `mention provider search isolated failure provider=${id} error=${error instanceof Error ? error.message : String(error)}`,
          );
          return [];
        }
      },
      async resolve(itemId) {
        // SDK resolve(itemId) does not receive composer projectId. Prefer the
        // project remembered from the latest search; otherwise scan accepted
        // cache scopes (resolveMentionScopes null fallback).
        const projectId =
          (await bb.storage.kv.get<string>(
            "finite-state:last-mention-project",
          )) ?? null;
        return resolveProvider(id, ctx.db(), projectId, itemId, {}, ctx.log);
      },
    });
  }
}
