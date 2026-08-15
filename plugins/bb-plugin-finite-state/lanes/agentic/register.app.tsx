import type { PluginAppBuilder } from "@bb/plugin-sdk/app";
import type { AppContext } from "../../lib/app-context.js";
import { registerDirectives } from "./directives/register.js";

export function registerAgenticApp(
  app: PluginAppBuilder,
  ctx: AppContext,
): void {
  registerDirectives(app, ctx);
}
