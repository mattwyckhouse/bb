export const HARDWARE_TABS = ["schematics", "board", "fab"] as const;
export type HardwareTab = (typeof HARDWARE_TABS)[number];

export function hardwareTabFromSubPath(subPath: string): HardwareTab {
  const candidate = subPath.split("/", 1)[0];
  return HARDWARE_TABS.find((tab) => tab === candidate) ?? "schematics";
}
