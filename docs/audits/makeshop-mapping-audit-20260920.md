# Makeshop mapping audit — 2026-09-20

Production project `bpgvqmtsjgegnrdzmpep` was queried read-only. No mapping, suppression, snapshot, or seller data was changed.

## Exact effective-key contract

An edge is suppressed only when all four values match:

`source_channel + sellpia_sku_code + product_code + option_code`

The audit does not count the raw cached projection as an effective mapping.

## Counts

| Measure | Count |
| --- | ---: |
| Raw distinct cached edges | 18,572 |
| Makeshop suppression records | 1,972 |
| `operator_disconnect` | 1,736 |
| `operator_disconnect_source_missing` | 236 |
| Raw edges removed by an exact suppression | 1,891 |
| Effective edges after suppression | 16,681 |
| Raw collision identities | 1,967 |
| Raw collision products | 362 |
| Effective collision identities | 263 |
| Effective collision products | 82 |
| Effective collision candidate edges | 546 |
| Active-component duplicate identities | 0 |
| Manual-link duplicate identities | 0 |

## Remaining 263 identities

| Classification | Identities | Products | Candidate edges | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Legacy-only collision | 207 | 52 | 434 | The seller identity no longer exists in the active seller-listing projection. All candidate Sellpia SKUs still exist in the latest Sellpia source. Treat as stale/source-missing seller legacy cache, not as an active ambiguity. |
| Explicit active component plus legacy candidate | 56 | 30 | 112 | Exactly one active component and one legacy cached candidate share the identity. The active component is authoritative; the legacy candidate must not be revived by the export resolver. |
| Multiple explicit active components | 0 | 0 | 0 | No real active-component collision was found. |
| Duplicate manual links | 0 | 0 | 0 | No manual-link collision was found. |

Of the 207 legacy-only identities, 192 identities (42 products, 390 cached edges) still appear in the current seller inventory snapshot but have no explicit active component. The remaining 15 identities (12 products, 44 cached edges) are absent from the current seller inventory snapshot as well. This distinction is diagnostic only: neither group is promoted over an explicit active component, and no mapping was changed by this audit.

## Representative legacy-only examples

- product `2084109`, blank option: 8 cached SKU candidates (`10571-23`, `10571-25`, `10571-27`, `10571-28`, `10571-29`, `10571-30`, `10571-31`, `10571-32`)
- product `2082413`, blank option: 5 cached SKU candidates (`10344-1` through `10344-5`)
- products `2085306` and `2085307`, blank option: 4 cached candidates each

## Representative explicit-plus-legacy examples

- product `115578`, options `1`–`3`: one active component plus one legacy cached candidate per identity
- product `121577`, multiple options: one active component plus one legacy cached candidate per affected identity

## Conclusion

The remaining raw warning volume is a projection/cache lifecycle issue. It is not evidence that the operator must disconnect hundreds of current mappings again. Carrier export must use exact suppressions and active components first, and must not promote a legacy cached candidate when an authoritative active component exists or the seller identity is absent from the active listing projection.
