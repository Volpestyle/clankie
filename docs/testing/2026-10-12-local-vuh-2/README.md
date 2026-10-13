# LOCAL-VUH-2: preserve the distinct built-in namespace

Tracks: LOCAL-VUH-2 — builtin UUID `814ca072-f856-4147-bcfc-6ceb045dda17`,
Clankie Work project `cbd205ab-cad4-48b8-9724-7109410fc921`.

The core change documents the supported, existing scheme in `docs/cli.md` and
`.agents/skills/work-items/SKILL.md`. No allocator, identifier, counter, imported
graph, tracking convention, account/scope/credential setting, or app source
changed. Default stores use `LOCAL-n`; a store holding the imported VUH team
allocates `LOCAL-VUH-n` independently of preserved imported `VUH-n` identifiers.
ADR 0226 already accepts this deliberate prefix. No supported allocator bug was
demonstrated by source mapping.

[Inspected production store/API proof, final namespace doc diff and source hashes](clankie://evidence/sha256/b2934bd45982cbf0c6ad17fea9a558672d7d654d1dc63b1eae2b4916ec0c1c45)

## Source and scope

One isolated core clone, branch `local-vuh-2`, created from fetched origin/main
`8e3d6ae62a3afbaf19ab3241fc4ad4c07ffa417a`. Exact builtin item/project reads used
the authenticated native worker bridge with `repo` omitted. Read receipts:
item `5a31359c-3f5c-4442-8067-e247ace7e77d`, project
`4508076d-0e8e-484e-a089-418d497c0b87`; worker-stamped lease receipt
`08a7990a-81bc-4492-b4ad-47ccc35f6e84`, run
`f4cfe1f5-c010-447d-ba48-ca6a61f2bc41` (start receipt `da710fa4-4f35-428b-96ed-610be61f788e`).
The local `me` read reports a builtin local user, not a Linear-authenticated actor;
the actual write attribution identifies this admitted worker.

The production flow is `localKey` → `saveIssue` under `withTrackerStoreLock` →
atomic persisted store and keyed receipt. Import retains provider identifiers
and team; promotion retains that store's native counter. The whole identifier,
not its suffix, is the lookup and evidence key. No supported API rewinds the
counter. Manually corrupted counters are outside the normal-flow proof.

## Disposable production store/API proof

Passed with exit 0: `clankie heavy -- ./apps/clankie/node_modules/.bin/tsx
.local/namespace-proof.ts` (original queued session 41394; no queue bypass).
The actual exported production backend API persisted real files, imported the
existing real captured Linear graph, and used production promotion before
creating items. No storage, renderer or API response was mocked; no current
provider request was made. This is a store/backend API proof, not an HTTP service
or UI runtime proof.

- A fresh default store allocated `LOCAL-1`.
- Five captured imported issues retained their exact UUIDs and `VUH-n` keys;
  their full returned issue/relation views were identical before and after.
- Eleven committed native items had eleven distinct UUIDs and complete keys
  `LOCAL-VUH-1` through `LOCAL-VUH-11`, disjoint from every imported key.
- Eight concurrent backend instances in one Node process allocated distinct
  numbers. Independent-process contention was not exercised.
- Three identical keyed calls (including two concurrent calls) returned the
  same complete response and allocated one item.
- Reopening from disk retained the team/sequence; the next item was 11 and the
  final counter was 12. Full key and UUID lookups resolved every native item;
  shortening `LOCAL-VUH-1` to `VUH-1` did not resolve it.
- Allocator, lock, schema, import source, fixture and one-off script SHA-256
  hashes matched before/after execution. The archived JSON includes these
  hashes, raw API responses, production bootstrap and full disposable store.

The one-off script and raw results remain evidence/local artifacts rather than
new shipped automation or tests. All execution and checks use `clankie heavy`.

## Inspected existing UI evidence

Hash-verified historical real captures were fetched into this checkout's ignored
local evidence mirror and visually inspected. The original Work sync proof's
README describes disposable real service/relay and paired clients. Its doc
commit is app `7c381d988cd9c8195e5b50047f8efde2c795a60d` (October 9); it names core
`6f7e23aa2` then `9e0aae589`, but does not pin exact app capture source revisions.

- [iPhone detail, full LOCAL-VUH-12](clankie://evidence/sha256/a73ac933f784c10f86c029480d68983b0e36b84cb4ad3fc3802dcf87e53fe1b6)
- [iPad detail, full LOCAL-VUH-11](clankie://evidence/sha256/41f25b7e14d46a2f2c749494512d574a749049836f59ec58ba05d1b6d739af22)
- [Web phone detail, full LOCAL-VUH-9](clankie://evidence/sha256/6e01b766315bff6541fb8f56de82d4d81957c55b2e3e69eb2143e00dbdcdc131)
- [Web tablet detail, full LOCAL-VUH-10](clankie://evidence/sha256/8dbc6cb93c3c7a04f6be8e7464c1f2a795cd52502b014d650cfa06eaea8ad4c1)
- [Historical iPhone project rows, visibly truncated LOCAL-V…](clankie://evidence/sha256/99ceb9434af95f1d76eece904678b1831caf236a44be783fa7b9de6bae999a8e)

These are reused historical pixels, not newly seeded or current UI captures.

## Current app source observation — not a runtime UI pass

Fetched app origin/main `9711235028fd03ce10db7bb3169386cfd2bcb367` was inspected
read-only in an owned bare source store. The owner checkout `0ed19df9` was stale
and its findings are superseded. No app checkout/source/binding was changed.

At that fetched revision (paths under `packages/command-center/src/`):

- `workItems/syncView.ts:48` preserves the full identifier; `v2/work/IssueView.tsx:55`
  renders the complete detail identifier without a line limit.
- `v2/work/ProjectSheet.tsx:380/426` uses one line and a 72-point ID field. Native
  `v2/work/workRaster.ts:29` and web `workRaster.web.ts:20` explicitly pass the
  complete ID through `clippedTitle` with width 72. Actual current ellipsis is
  an inference from source; no current runtime pixels were observed.
- `v2/work/updateMarkdown.ts:35-39` recognizes one-prefix issue keys. Bare
  `LOCAL-VUH-2` is parsed as `LOCAL-` text plus a `VUH-2` token. `RichText.tsx:77-85`
  can target that different suffix item if it exists in the issue map; otherwise
  the reference remains plain text. Full-key links remain generic links.

Exact consumers and historical/source distinctions were reported to Clankie.
One native peer message reached Rowan's verified binding with receipt
`42172c3e-8a72-4d7d-83ee-bec9b7b46c37` (delivered/consumed). His reply
`1fa404fd-ba7b-4785-9cc8-e732ac9a92ee` accepts full-key expectations in his VUH-2182
Work destination/sheet/issue slice, but excludes legacy World raster clipping
and shared Markdown parsing. The bounded parser ownership need
(`updateMarkdown.ts`, `RichText.tsx`, focused full-key cases) was reported back
to the lead for explicit assignment. Rowan subsequently reports peer
`7565ed6c-1cf7-4cfe-ae78-bb669f9da782`: Clankie assigned the full-key Markdown parser
plus existing Markdown tests and page-only row width to his VUH-2182 landing;
`RichText` already targets the parsed exact key and needs no change. This is
coordination, not proof of his landing or current runtime acceptance. This
worker has not claimed or edited those app paths. No overlapping app fix or UI
harness, pairing, cache injection, or live takeover was attempted.

## Acceptance and handoff gaps

Original acceptance is retained: document the chosen scheme **and the app shows
it**, with no identifier collision. Current exact-revision app runtime coverage
is open, including full project-row identity and Markdown navigation; older
full-detail captures do not close it. Mac, hosted and physical-device coverage
are not claimed. Shared global integration owns exact-tree root check, landing,
push and deployment; this worker supplies no independent integration intent.
The lead closes work only after landing, checks and evidence meet acceptance.
Machine state lives in `.local/HANDOFF-LOCAL-VUH-2.md` in this owned checkout.
