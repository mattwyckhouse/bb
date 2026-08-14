import type { PluginAppBuilder, PluginNavPanelProps } from "@bb/plugin-sdk/app";
import type { AppContext } from "../../lib/app-context.js";
import { HardwarePanel } from "./ui/HardwarePanel.js";

function HardwarePanelSlot(props: PluginNavPanelProps): React.JSX.Element {
  return <HardwarePanel {...props} />;
}

export function registerHardwareApp(
  app: PluginAppBuilder,
  _ctx: AppContext,
): void {
  app.slots.navPanel({
    id: "hardware",
    title: "Hardware",
    icon: "Layers",
    path: "hardware",
    component: HardwarePanelSlot,
  });
}
