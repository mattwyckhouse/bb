export interface PublishStubResult {
  readonly target: "platform-graph";
  readonly status: "unavailable-stub";
  readonly message: string;
}

const AUTHORITY_DOCUMENT =
  "finite-studio/docs/Implementation/AUTHORITY — Git SoR, Platform Graph & AS Seed.md";

/** Reports the future publish destination without performing any publication. */
export function publishStub(): PublishStubResult {
  return {
    target: "platform-graph",
    status: "unavailable-stub",
    message: `Publishing .fs/ TARA contract entities to the future Platform Graph is unavailable because Platform does not yet host TARA entities. Nothing was sent. See ${AUTHORITY_DOCUMENT}.`,
  };
}
