import {
  useBbContext,
  type PluginMessageDirectiveProps,
} from "@bb/plugin-sdk/app";

/** Prefer the message project, then the host bb context. */
export function useDirectiveProjectId(
  message: PluginMessageDirectiveProps["message"],
): string | null {
  const { projectId: contextProjectId } = useBbContext();
  return message.projectId ?? contextProjectId;
}
