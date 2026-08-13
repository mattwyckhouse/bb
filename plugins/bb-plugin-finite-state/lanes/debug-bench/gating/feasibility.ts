export const DEBUG_MODE_FEASIBILITY = {
  refusalGate: "plugin-handler-precondition",
  conditionalTools: "next-session-resolution",
  hotSessionMutation: false,
  bbCoreChangeRequired: false,
  destructiveTurnEvidence: "unavailable",
} as const;

export interface DebugModeFeasibilityAssertion {
  refusalGate: boolean;
  conditionalToolsAtSessionStart: boolean;
  hotSessionMutationAttempted: boolean;
  bbCoreSourceUsed: boolean;
}
export function assertDebugModeFeasibility(
  assertion: DebugModeFeasibilityAssertion,
): void {
  if (!assertion.refusalGate) {
    throw new Error("DEBUG_MODE_FEASIBILITY_FAILED: handler refusal is required");
  }
  if (!assertion.conditionalToolsAtSessionStart) {
    throw new Error("DEBUG_MODE_FEASIBILITY_FAILED: next-session tool selection is unavailable");
  }
  if (assertion.hotSessionMutationAttempted) {
    throw new Error("DEBUG_MODE_FEASIBILITY_FAILED: hot session mutation is unsupported");
  }
  if (assertion.bbCoreSourceUsed) {
    throw new Error("DEBUG_MODE_FEASIBILITY_FAILED: plugin-only implementation required");
  }
}
