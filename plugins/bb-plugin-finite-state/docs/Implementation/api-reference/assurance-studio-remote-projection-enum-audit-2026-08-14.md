# Assurance Studio remote-projection enum audit — 2026-08-14

FS-207 audited every closed enum reached by the registered Assurance Studio
remote projection and by its canvas authoring/materialization consumers. This
is the grep-level inventory: a new remote vocabulary read or downstream enum
must add a row here before review.

## Reproduce the inventory

From `plugins/bb-plugin-finite-state`:

```sh
rg -n 'z\.enum|\.options|component_type|criticality|trust_level|asset_type|data_classification|category|threat_source|severity' \
  lanes/product-security/canvas/editing \
  lib/remote/assurance-studio lib/remote/types.ts

jq -r 'paths as $p | (getpath($p)) as $v |
  select(($v|type) == "object" and ($v|has("enum"))) |
  [($p | map(tostring) | join(".")), ($v.enum | tojson)] | @tsv' \
  docs/Implementation/api-reference/assurance-studio-openapi-2026-05-12.json
```

The executable field-read trace is pinned in
`lanes/product-security/canvas/editing/adapters.test.ts` under “pins and
adversarially exercises the field reads emitted by production projection.”

## Vocabulary dispositions

| Remote projection field     | Vendored authority                                                                                                                                                       | Disposition at remote boundary                                                                                                                                   | Downstream authored handling                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `component.component_type`  | `#/components/schemas/Component/properties/component_type` references the 13-value `ComponentType` enum, but the connected FS-206 corpus also returns `external_service` | **Bounded-open.** A deployed response contradicts the older snapshot; accept a trimmed 1–200 character string. The 14 observed values are a compatibility floor. | The form offers all 14 observed values. Other accepted values remain readable on the canvas but receive a typed, row-isolated advisory if editing would materialize strict YAML. Retired `ecu`, `hsm`, `tee`, and `medical_device` use the same isolation gate. |
| `component.criticality`     | `#/components/schemas/Component/properties/criticality` references `#/components/schemas/Criticality` (`low`, `medium`, `high`, `critical`)                              | **Genuinely closed.** The documented response enum remains enforced by remote projection.                                                                        | The same four-value authored pick-list is enforced with a typed validation error.                                                                                                                                                                               |
| `zone.trust_level`          | `#/components/schemas/Zone/properties/trust_level` references `#/components/schemas/TrustLevel` (`untrusted`, `semi_trusted`, `trusted`, `highly_trusted`)               | **Genuinely closed.** The documented response enum remains enforced by remote projection.                                                                        | The same four-value authored pick-list is enforced with a typed validation error.                                                                                                                                                                               |
| `asset.asset_type`          | `#/components/schemas/LinkedAsset/properties/asset_type` is an open string; the full Asset response is absent from the snapshot                                          | **Bounded-open.** Accept a trimmed 1–200 character string. The eight connected values are a compatibility floor.                                                 | The form offers the eight observed values. Other accepted values render read-only and are isolated from strict YAML materialization with a typed advisory.                                                                                                      |
| `asset.criticality`         | No Asset response enum is documented; the generic `Criticality` schema is referenced by Component, not Asset                                                             | **Bounded-open.** Per the absence rule, accept a trimmed 1–200 character string.                                                                                 | The four known choices are an authoring floor. Other accepted values render read-only and are isolated from strict YAML materialization with a typed advisory.                                                                                                  |
| `asset.data_classification` | No field or enumeration appears in the vendored snapshot; the FS-206 targeted connected verification recorded in FS-207 returned `pii`                                   | **Bounded-open.** Accept a trimmed 1–200 character string. `pii` plus the four prior authored choices are a compatibility floor.                                 | The asset form offers `public`, `internal`, `confidential`, `restricted`, and `pii`. Other accepted values render read-only and are isolated from strict YAML materialization with a typed advisory.                                                            |
| `threat.category`           | `#/components/schemas/Threat/properties/stride_categories/items` references the six-value `StrideCategory` enum                                                          | **Genuinely closed.** The adapter accepts the documented single category needed by authored YAML and rejects a multi-category response as a structural mismatch. | The six STRIDE values are enforced by the methodology-aware typed validator.                                                                                                                                                                                    |
| `threat.threat_source`      | `#/components/schemas/Threat/properties/threat_source` declares `imported`, `library`, `manual`, `stride_analysis`                                                       | **Genuinely closed.** The documented response enum remains enforced by remote projection.                                                                        | The same four-value authored pick-list is enforced with a typed validation error.                                                                                                                                                                               |
| `threat.severity`           | Threat has no `severity` response field; `risk_level` is documented but semantically different and is deliberately not substituted                                       | **Bounded-open when present.** Accept a trimmed 1–200 character string without inventing a value when absent.                                                    | The four known severity choices are an authoring floor. Other accepted values render read-only and are isolated from strict YAML materialization with a typed advisory.                                                                                         |

“Bounded-open” always means a non-empty trimmed string no longer than 200
characters. It does not mean accepting arbitrary JSON, blank strings, or an
unbounded payload.

## Other AS client enums inspected

- `AsReviewStatus` is transport metadata, not an authored remote vocabulary
  projection. It matches `#/components/schemas/ReviewStatus` exactly and lives
  in the frozen `lib/remote/types.ts`; FS-207 does not modify it.
- `AsEntityKind` is selected by the registered route and injected by the
  client rather than parsed from a tenant vocabulary field.
- deletion `cascade | detach` is a handler-backed command/impact contract, not
  remote entity vocabulary.
- Requirement, verification-check, project-SBOM, and project-link adapters
  preserve remote record vocabulary as bounded strings/JSON and do not apply a
  closed enum in their remote projection. Their local workflow/evidence enums
  are not parses of a remote vocabulary field.
- Interface `direction` is authored-only; the AS Component response exposes
  interface labels, so it is not read by remote projection. Data-flow protocol
  and data types are already bounded-open strings.

No enum in `shared/contract.ts` is a remote vocabulary parse in this audit, and
FS-207 leaves every frozen artifact unchanged.

## Row isolation and identity

The remote boundary preserves every bounded-open value in the accepted row.
Canvas reads use string-valued fields and can render a future value without a
closed parse. Editing and automatic YAML materialization call
`validateArchitecturePayload`; vocabulary-only failures are typed and skip
only that accepted row, while malformed structure and stable-key mismatches
still fail closed. Stable keys remain resolved slugs, so none of the vocabulary
changes alters accepted identity or `id_map` ownership.
