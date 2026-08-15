import type { BbPluginApi } from "@bb/plugin-sdk";
import type { PluginContext } from "../../lib/context.js";
import { registerMentions as registerOwnedMentions } from "./mentions/register.js";
import { registerActionTools as registerOwnedActionTools } from "./tools/actions.js";
import { registerReadTools as registerOwnedReadTools } from "./tools/read.js";
import { registerWriteTools as registerOwnedWriteTools } from "./tools/write.js";
import { registerFiniteStateCli as registerOwnedFiniteStateCli } from "./cli/register.js";

export type AgenticRegistrar = (bb: BbPluginApi, ctx: PluginContext) => void;

// Composition seams for WP-58–WP-60, WP-62, and WP-64. Each owner replaces
// its no-op with a thin import; domain handlers remain in their owner modules.
export const registerReadTools: AgenticRegistrar = registerOwnedReadTools;
export const registerWriteTools: AgenticRegistrar = registerOwnedWriteTools;
export const registerActionTools: AgenticRegistrar = registerOwnedActionTools;
export const registerMentions: AgenticRegistrar = registerOwnedMentions;
export const registerFiniteStateCli: AgenticRegistrar =
  registerOwnedFiniteStateCli;

const REGISTRARS = [
  registerReadTools,
  registerWriteTools,
  registerActionTools,
  registerMentions,
  registerFiniteStateCli,
] as const;

export function registerAgentic(bb: BbPluginApi, ctx: PluginContext): void {
  for (const register of REGISTRARS) register(bb, ctx);
}
