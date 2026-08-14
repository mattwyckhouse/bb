import { findingStableKey, type FindingKeyTier } from "../../../lib/sync/registry.js";

const CVE = /^CVE-\d{4}-\d+$/u;

export interface FindingIdentityInput {
  cve: string;
  purl: string | null;
  name: string;
  group: string | null;
  version: string | null;
}

export interface CanonicalFindingIdentity extends FindingIdentityInput {
  tier: FindingKeyTier;
}

/** Selects a CVE without allowing an opaque vulnerability UUID to outrank findingId. */
export function selectFindingCve(fields: Readonly<{
  cve: string | null;
  findingIdentifier: string | null;
  findingId: string | null;
  vulnerabilityId: string | null;
}>): string | null {
  const declared = [fields.cve, fields.findingIdentifier, fields.findingId]
    .find((value): value is string => value !== null && CVE.test(value));
  return declared ?? fields.cve ?? fields.findingIdentifier ?? fields.vulnerabilityId;
}

function decodeWireVersion(version: string): string {
  try {
    return decodeURIComponent(version);
  } catch (error: unknown) {
    throw new TypeError(`Finding component version is not valid percent-encoding`, { cause: error });
  }
}

/**
 * Canonicalizes raw Platform component identity without consulting the
 * portfolio-wide component index. The untouched wire record remains in the
 * findings cache's raw column for push and diff surfaces.
 */
export function canonicalizeFindingIdentity(input: FindingIdentityInput): CanonicalFindingIdentity {
  let name = input.name;
  let group = input.group;
  if (input.purl === null && group === null) {
    const separator = name.lastIndexOf("/");
    if (separator > 0 && separator < name.length - 1) {
      group = name.slice(0, separator);
      name = name.slice(separator + 1);
    }
  }
  const version = input.version === null ? null : decodeWireVersion(input.version);
  const tier: FindingKeyTier = input.purl !== null
    ? "purl"
    : version !== null
      ? "name-group-version"
      : "name-group-any-version";
  return { ...input, name, group, version, tier };
}

export function canonicalFindingStableKey(identity: CanonicalFindingIdentity): string {
  return findingStableKey({
    cve: identity.cve,
    purl: identity.purl,
    name: identity.name,
    group: identity.group,
    version: identity.version,
  }, identity.tier);
}

export function legacyFindingStableKey(identity: FindingIdentityInput): string | null {
  const tier: FindingKeyTier = identity.purl !== null
    ? "purl"
    : identity.version !== null
      ? "name-group-version"
      : "name-group-any-version";
  try {
    return findingStableKey({
      cve: identity.cve,
      purl: identity.purl,
      name: identity.name,
      group: identity.group,
      version: identity.version,
    }, tier);
  } catch {
    return null;
  }
}
