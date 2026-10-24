# Integrate review gate regression and audit (VUH-2790)

Candidate verification; not a live service deployment or a landing. The owner will
land after Sage reviews the exact committed patch. No live integrate batch or
push was requested. Queue tests use disposable local Git origins.

The sandbox intentionally changes HOME, settings and credentials paths, removes
fleet links, and points the service URL at port 1. Previously the missing verdict
fell through to the gate's `CI=1` skip. The fix reads the source project's verdict
in the owning service and passes only the verdict plus exact base/HEAD binding to
local and remote sandboxes. Status validates that binding and the patch ID. The
parent refreshes review after checks and before push; unavailable verdicts hold.
External CI may skip an unavailable service only without owner settings.

## Log audit

Inspected 1,030 retained batch records and every matching gate log. Found 77 core
skip logs on 2026-10-23/24: 71 pushed batches, four failed and two held. Of the
71 pushed batches, 50 had an empty core diff. The remaining 21 are below: 20
have an exact-patch lead waiver timestamped before push. The reported VUH-2779
batch has CHANGES at 15:58:35Z and push at 16:15:50Z, with no waiver.

This does not claim those 20 patches lacked authorization: the gate logged the
wrong skip even though a valid waiver existed. Empty core logs do not prove
anything about the sibling app gate. Current settings are not historical
per-batch snapshots; candidate and waiver records establish reviewer handling
for these nonempty core patches. `audit.json` retains all 77 matching batches,
full commit IDs, log paths/line numbers, candidate/waiver timestamps, focused
check output and package typecheck reports.

| Batch                                  | Core HEAD      | Push (UTC)               | Exact-patch record                            |
| -------------------------------------- | -------------- | ------------------------ | --------------------------------------------- |
| `d903bec9-024b-488c-9521-c1646e9095a9` | `91e20d21fba4` | 2026-10-23T15:24:58.396Z | Lead waiver before push (`VUH-2700-core`)     |
| `2bad3b1f-e41d-4139-8aee-91a57c2d956a` | `af52d4aa13f0` | 2026-10-23T16:03:33.360Z | Lead waiver before push (`no issue recorded`) |
| `6d57f67d-5e29-4d41-a6d2-737ce40177ce` | `dc046a4525f2` | 2026-10-23T16:55:51.833Z | Lead waiver before push (`VUH-2711-core`)     |
| `7b733c03-86f2-48c7-a931-92c38752d71c` | `80dd53975455` | 2026-10-23T17:00:18.865Z | Lead waiver before push (`VUH-2712-core`)     |
| `e69f59db-e8ee-4219-88a9-ade9b6921e3e` | `aa7bf460d20d` | 2026-10-23T17:44:58.342Z | Lead waiver before push (`VUH-2713`)          |
| `8098528b-50e8-4afd-b73b-768d015db6e2` | `7298d2082867` | 2026-10-23T18:02:22.914Z | Lead waiver before push (`no issue recorded`) |
| `40e2046a-b3f6-4c8c-a6ba-596b4a35a59d` | `14cfeae869ee` | 2026-10-23T18:21:48.633Z | Lead waiver before push (`VUH-2727-core`)     |
| `d717980f-a5f1-4726-a8a2-b8f80c2bca37` | `2e26ed29132d` | 2026-10-23T20:17:54.771Z | Lead waiver before push (`VUH-2686`)          |
| `502aae5e-bf65-45ca-8d7a-4df7277da9d6` | `11d6efbdcf1f` | 2026-10-23T20:20:45.851Z | Lead waiver before push (`VUH-2700-test-fix`) |
| `85dca8a8-8d4b-4f03-945a-e31dff57eceb` | `a24c8f5732b6` | 2026-10-23T20:44:58.390Z | Lead waiver before push (`VUH-2728`)          |
| `8482667f-894d-4272-be09-c8517aed22dc` | `ebb084867826` | 2026-10-23T21:11:59.919Z | Lead waiver before push (`VUH-2722`)          |
| `7d72a468-eb82-4707-bb4e-6b5014fd7534` | `57febba8fae7` | 2026-10-23T21:38:19.827Z | Lead waiver before push (`VUH-2725-core`)     |
| `9dd5630f-a94e-4685-a4d5-e9c6c7427aa1` | `a2ce4ae749ff` | 2026-10-23T22:19:39.070Z | Lead waiver before push (`VUH-2687-core`)     |
| `0daf7418-f0c1-4a41-9078-303a02636c6c` | `8a456c710fd4` | 2026-10-23T23:39:46.535Z | Lead waiver before push (`VUH-2742-core`)     |
| `4566f3e5-8f8d-491c-a2df-039a0970878d` | `5fb1545479cc` | 2026-10-24T00:24:27.799Z | Lead waiver before push (`VUH-2752`)          |
| `ac7bc236-fee0-479c-aa21-c21d94ecda6c` | `8322bd3a9be7` | 2026-10-24T01:41:54.905Z | Lead waiver before push (`VUH-2764-core`)     |
| `ad7a04a8-c59e-4d7d-a12d-01182ede6cae` | `b8b7ad85ca55` | 2026-10-24T02:11:34.020Z | Lead waiver before push (`VUH-2728`)          |
| `54559143-c8f2-4a64-b84e-d68c1275da2f` | `1985611d3974` | 2026-10-24T05:16:27.503Z | Lead waiver before push (`VUH-2761-core`)     |
| `37a241f4-0b1e-4abc-8e28-1755fe5d51e3` | `005b72eeaa88` | 2026-10-24T06:18:31.403Z | Lead waiver before push (`VUH-2765`)          |
| `51492158-652d-4492-870b-dc5053e34bf8` | `2432ea447874` | 2026-10-24T09:52:52.905Z | Lead waiver before push (`VUH-2558`)          |
| `1f8dc47f-240e-4048-8ca9-a84ebbe77d84` | `3ce47cfca006` | 2026-10-24T16:15:50.073Z | CHANGES before push; no waiver (`VUH-2779`)   |

## Verification

- Review regression, sandbox environment and real review lifecycle: six tests passed.
- Queue hold, remote verdict transfer and reused gates: five selected tests passed.
- Moving-main revalidation and reclamation: two selected tests passed.
- The three review regressions were rerun after adding the assertion that the
  original isolated CLI fails with `Reviews need the operator credential`.
- The remote transfer proof was rerun after guarding the runner's `rm` paths.
- Scoped lint and formatting passed. Both affected package typechecks
  (`@clankie/clankie` and `@clankie/tui`, source and test programs) passed.

These are 13 distinct focused tests; no full suite, eval, release or live batch.
The remote runner proof uses the actual POSIX shell program locally with isolated
Git origins and tool homes; it does not establish live SSH/WSL transport behavior.
