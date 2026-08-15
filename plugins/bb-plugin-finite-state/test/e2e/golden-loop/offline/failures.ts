export type FailureScenario =
  | "sync-conflict"
  | "partial-push-disconnect"
  | "writer-interrupted"
  | "firmware-gap-or-admin-denied"
  | "bench-unavailable-or-ambiguous"
  | "attestation-binding-invalid";

export interface RecoveryProof {
  scenario: FailureScenario;
  visibleStatus: string;
  unsupportedSuccessShown: false;
  durableArtifacts: string[];
  recoverySteps: string[];
  finalState: "resumable" | "recovered" | "honestly-blocked";
}

interface FailureRecord {
  readonly at: string;
  triggered: boolean;
  proof: RecoveryProof | null;
}

const records = new Map<FailureScenario, FailureRecord>();

export class InjectedGoldenLoopFailure extends Error {
  constructor(
    readonly scenario: FailureScenario,
    readonly at: string,
  ) {
    super(`INJECTED_FAILURE scenario=${scenario} at=${at}`);
    this.name = "InjectedGoldenLoopFailure";
  }
}

export function injectFailure(name: FailureScenario, at: string): void {
  const trigger = at.trim();
  if (trigger === "") throw new Error("Failure trigger point must be named");
  records.set(name, { at: trigger, triggered: false, proof: null });
}

export function triggerFailure(name: FailureScenario, at: string): void {
  const record = records.get(name);
  if (!record || record.at !== at) return;
  record.triggered = true;
  throw new InjectedGoldenLoopFailure(name, at);
}

export function recordRecovery(proof: RecoveryProof): void {
  const record = records.get(proof.scenario);
  if (!record?.triggered) {
    throw new Error(`Recovery recorded before ${proof.scenario} was triggered`);
  }
  if (proof.unsupportedSuccessShown !== false) {
    throw new Error(`${proof.scenario} displayed unsupported success`);
  }
  if (proof.visibleStatus.trim() === "") {
    throw new Error(`${proof.scenario} has no visible status`);
  }
  if (proof.durableArtifacts.length === 0) {
    throw new Error(`${proof.scenario} preserved no durable artifacts`);
  }
  if (proof.recoverySteps.length === 0) {
    throw new Error(`${proof.scenario} has no recovery steps`);
  }
  record.proof = {
    ...proof,
    durableArtifacts: [...proof.durableArtifacts],
    recoverySteps: [...proof.recoverySteps],
  };
}

export async function assertRecovery(
  name: FailureScenario,
): Promise<RecoveryProof> {
  const record = records.get(name);
  if (!record?.triggered) throw new Error(`${name} was not triggered`);
  if (!record.proof) throw new Error(`${name} has no recovery observation`);
  return {
    ...record.proof,
    durableArtifacts: [...record.proof.durableArtifacts],
    recoverySteps: [...record.proof.recoverySteps],
  };
}

export function resetFailures(): void {
  records.clear();
}
