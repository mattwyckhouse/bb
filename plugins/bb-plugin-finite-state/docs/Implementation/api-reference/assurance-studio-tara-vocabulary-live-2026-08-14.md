# Assurance Studio TARA vocabulary — connected capture 2026-08-14

Sources: FS-206 UX sweep #9 and the FS-206 targeted connected verification
recorded in FS-207 against the production `fs-alpha` Assurance Studio tenant.
The connected I4700A corpus returned these wire values:

- `asset_type`: `function`, `integrity`, `identity`, `software`, `data`,
  `availability`, `hardware`, `communication`
- `component_type`: the vendored OpenAPI `ComponentType` values plus
  `external_service`
- `data_classification`: `pii`

The observed eight-value `asset_type` set is a compatibility floor, not a
closed tenant-wide ceiling. Other projects or tenants may return additional
non-empty values.

The observed `data_classification` value `pii` and the authored choices
`public`, `internal`, `confidential`, and `restricted` are likewise a
compatibility floor, not a closed tenant-wide ceiling. The vendored OpenAPI
does not document `data_classification` on an Asset response.

The May 2026 vendored OpenAPI describes `LinkedAsset.asset_type` as an open
string and does not include `external_service` in `ComponentType`. It also
does not document Asset `criticality`, Asset `data_classification`, or Threat
`severity`. Remote projection therefore accepts any non-empty bounded string
for those fields while authored UI choices present the known sets. The
vendored `Criticality` enum remains authoritative only for the documented
Component `criticality` field.

None of these vocabulary fields participates in the lane's stable identity.
Components, assets, and threats continue to key by their resolved stable slug,
so retaining a new wire vocabulary value does not change `id_map` bindings or
accepted entity keys.
