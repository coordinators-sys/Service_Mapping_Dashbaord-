# Service Mapping — data model, grains and lineage

Reference for anyone maintaining the pipeline or interpreting the published
figures. Companion to the in-dashboard Methodology drawer (which is the
audience-facing version).

## 1. Analytical grains

Three different things get counted. Mixing them is the single largest source of
misleading numbers, so each has its own vocabulary and its own KPI.

| Grain | One row per | Where it is used |
|---|---|---|
| **Source record** | Kobo submission × sector | raw ingest, CSV record export |
| **Assessment** | submission, at its declared level | Assessments section, assessment KPIs, assessment export |
| **Site × sector × period cell** | canonical site × sector × month | all coverage %, gap profiles, map colours |

A district assessment is **not** a site. A single "sites" number across mixed
grains is never published.

### `scopeType` — the declared grain

Taken from the form's `level` question and normalised through a controlled
vocabulary (`District Level` → `district`, etc.). An unrecognised value is
**not** defaulted to site — it yields `null` and raises
`UNKNOWN_REPORTING_LEVEL`.

The form only asks `level` for service mapping, so facility-mapping and
pre-v6 submissions carry none — around 16,000 records. A submission that
**names a site** has an unambiguous grain, so it is treated as site level and
flagged `REPORTING_LEVEL_INFERRED` (low severity, published). The inference is
recorded on the record, never silent. With no level **and** no site the grain
really is undefined and the record is quarantined — which is why this cannot
degrade into a blanket default to site.

Only the identifiers relevant to the declared grain are populated:

| scopeType | region | district | catchment | site |
|---|---|---|---|---|
| `district` | ✓ | ✓ | null | null |
| `catchment` | ✓ | ✓ | ✓ | null |
| `site` | ✓ | ✓ | (enrichment) | ✓ |

Unresolved child identifiers stay `null` and carry a reason code. Nothing is
invented — no fabricated site, catchment or coordinate.

## 2. Organisation roles

Two distinct fields, from two distinct places in the form:

| Field | Source | Meaning |
|---|---|---|
| `reportingPartner` | `organization_updating` | the agency that **conducted** the assessment |
| `agency` | `agency_<sector>` repeat groups | the agency **delivering** a service at that location |

Kobo submits the choice-list **code** (`acted`), not the label. Codes are
resolved through `data/organizations.json` (generated from the form) and then
through the reviewed alias table, which is where **retired** codes live — e.g.
`pmwd` is the pre-v6 code for PMWDO. Unknown codes pass through unchanged
rather than being guessed at or dropped.

They are filtered separately (Reporting Partner vs Agency). Provider rows never
populate `reportingPartner`.

## 3. Administrative resolution

**`data/admin-reference.json` is authoritative.** It is keyed on the **Kobo
form's own p-codes**, because that is what submissions actually contain.

> The previous lookup (`data/admin-pcodes.json`) was derived from the UNDP
> admin2 shapefile, which uses a *different* p-code scheme. Where they
> disagreed, records were published under the wrong district with no error:
> `SO2302` is **Afgooye** in the form but "Mogadishu Dayniile" in the
> shapefile, so Afgooye submissions appeared as **Daynile**. `SO2605`
> (**Doolow**) appeared as "Belet Xaawo". This is why a record could be present
> in the payload yet impossible to find.

Resolution order: form reference → legacy shapefile lookup → raw p-code
(flagged `UNRESOLVED_DISTRICT`). A code is never dropped.

Official display names come from the CCCM master site list. Spelling
differences are handled in `data/name-aliases.json` (e.g. `baydhaba` →
`Baidoa`) — controlled configuration, never transformation code.

Regenerate after any form or master-list change:

```bash
python scripts/build_admin_reference.py ML/Service_Mapping_Tool_v6.xlsx
```

### Catchment

Read from `group_general_info/subdistrict` — **the source**, not a matched
site. Submissions send the district p-code concatenated with the catchment code
(`SO2401CA12`), so the p-code prefix is stripped before matching; the raw value
is retained verbatim. (Reading it from the site is what dropped `CA12` from a Baidoa
catchment-level assessment, which has no site to read from.) Matched
exact-code **within the declared district only**, because CA codes repeat
across districts.

## 4. Publication states

Every submission ends in exactly one terminal state. Nothing is silently
dropped.

| State | Meaning |
|---|---|
| `published` | no blocking issue |
| `published_with_warning` | representable accurately, one unresolved child reference |
| `quarantined` | cannot be shown without misleading the reader |
| `superseded` | a newer version of the same logical submission exists |
| `rejected` | structurally unusable |

Severity → policy: `low` publish · `medium` publish with warning · `high` and
`critical` quarantine. Codes and explanations live in `api/lib/publication.py`.

Key codes: `MISSING_REQUIRED_CATCHMENT`, `UNRESOLVED_CATCHMENT`,
`UNRESOLVED_SITE`, `MISSING_SITE_REFERENCE`, `UNKNOWN_REPORTING_LEVEL`,
`UNRESOLVED_DISTRICT`, `MISSING_DISTRICT`, `NO_LOGICAL_KEY`,
`REPORTING_LEVEL_INFERRED`, `SUPERSEDED_VERSION`.

Every record from **every** source reaches a terminal state, including the
ZiteManager provider directory — see §10.

Validation is evaluated **at the declared grain** — a district assessment is
complete without a catchment or a site. This is what stops valid area-level
assessments being treated as failed site matches.

## 5. Versioning and idempotency

Logical key = `meta/rootUuid`, falling back to `_uuid`. Newest version wins
(by submission time, then form version, then `_id`); older versions are marked
`superseded` and **retained** for audit. Re-processing the same payload is
idempotent.

## 6. Lineage

Every published record carries: `sourceId` (Kobo `_id`), `sourceRootUuid`,
`sourceVersion`, `districtRaw` / `regionRaw` (the submitted p-codes),
`catchmentRaw`, `reportingLevelRaw`. Normalised values sit **beside** the raw
ones, never on top of them.

## 7. Update-cycle status

`data/partner-update-status.json` records what a partner reported for a cycle,
including districts **confirmed unchanged**.

`confirmed_no_change` is a partner statement, not an assessment. It never
creates an assessment fact and is never inferred from the absence of a Kobo
submission — "no submission" and "confirmed no change" are different facts.

## 8. KPI definitions

| KPI | Numerator | Grain |
|---|---|---|
| Assessments | submissions, excluding superseded | assessment |
| Districts assessed | distinct districts with ≥1 assessment | assessment |
| Catchments assessed | distinct catchments named by catchment-level assessments | assessment |
| Sites assessed | distinct sites named by **site-level** assessments | assessment |
| Reporting partners | distinct agencies that conducted assessments | assessment |
| Assessments with warnings | `published_with_warning` | assessment |
| Sector coverage % | covered ÷ (covered + not covered) | site × sector × period |

`Unknown` is excluded from every coverage denominator and never counted as
"not covered".

## 9. Regression fixtures

`tests/test_acted_regression.py` pins six real Kobo submissions (July 2026),
each covering a distinct failure class — wrong district, lost catchment,
missing catchment, area-level loss, duplicate-looking site codes, provider vs
reporter confusion. Treat them as permanent; they are the guard against this
class of defect returning.

## 10. The ZiteManager provider directory

A **reference source**, not assessments. Nobody conducted a directory entry and
it declares no reporting level, so `reportingPartner` and `scopeType` are
explicitly null and its rows are **excluded from the assessment grain**. They
carry a `submissionUuid`, and counting them there had the Assessments KPI
reading 8,446 against 2,718 real assessments.

They still reach an explicit terminal state, because "no record is left
unclassified" applies to every source. They continue to contribute to sector
**coverage** at the sites they match.
