# TUI menu test pruning — VUH-1925

Eight mixed TUI files lose presentation assertions and two incidental or
higher-tier-duplicate cases. No E2E, integration, golden, published contract or
real-bug regression case is removed. The review remains incomplete.

## Reviewed cuts and retained behavior

- `external-activity.test.ts`: remove exact collapsed heading/fallback copy.
  Keep the real component's expanded quoted Linear payload.
- `machines-menu.test.ts`: remove picker ordering and agent-count hint copy.
  Keep exact command dispatch, discovered transport, protected default session,
  named connection grants, reconnect and refusal before subsequent mutations.
- `product-navigation.test.ts`: remove menu title and empty-state copy; compare
  membership as sets instead of requiring incidental order. Preserve selected
  conversation, agent-thread exclusion, reachable history and native agent identity.
- `settings-menus.test.ts`: remove quiet-hour title and recording hint snapshots.
  Keep actual persisted quiet hours, recording toggle and failure detection.
- `setup-commands.test.ts`: remove setup prompt/hint/description/result copy and
  unused test-only captures. The duplicated worker-option assertion remains
  covered by the explicit doctor-session checklist case. Keep credential readiness,
  abandonment, routed commands, autostart calls, editable draft, pairing/sign-in
  routing and refusal to draft a message when the console is unavailable.
- `voice-commands.test.ts`: remove repeated helper-description labels and cosmetic
  wizard/status copy. The deleted helper case supplied no secret marker and only
  checked labels. Keep the actual wizard/API integration, broker-owned credentials,
  marker-based output/settings redaction, effective-environment refusal, canceled
  and stale drafts, URL-safe identifiers and optional model persistence.
- `persona-commands.test.ts`: remove prompt label arrays. Keep actual current-value
  defaults and alias-step recovery, stale-write refusal and service-unavailable
  mutation refusal without changing local data.
- `project-menu.test.ts`: remove first-row hint formatting. Keep the complete
  revision-bearing API/settings integration for edits and project creation.

The only product-source change removes the `describeVoice` export used by the
removed helper snapshot: **export-only, no behaviour change**. Its body and
internal caller remain byte-identical; all other test/product source stays intact.
No Knip exemption, test selector, fixture timeout or replacement snapshot is added.

## Lines and cases

| File under `apps/tui/test/`  | Before | After | Removed |
| ---------------------------- | -----: | ----: | ------: |
| `setup-commands.test.ts`     |    312 |   289 |      23 |
| `product-navigation.test.ts` |    102 |   100 |       2 |
| `machines-menu.test.ts`      |    107 |   104 |       3 |
| `settings-menus.test.ts`     |     63 |    57 |       6 |
| `external-activity.test.ts`  |     32 |    22 |      10 |
| `voice-commands.test.ts`     |    347 |   316 |      31 |
| `persona-commands.test.ts`   |    123 |   115 |       8 |
| `project-menu.test.ts`       |     84 |    82 |       2 |

Total test source: **1,170 → 1,085 lines**.
Cases in these eight files: **38 → 36**. Three navigation membership assertions
retain their exact sets while allowing incidental order to change.

## Measurement and landing

The one baseline root `check:landing` passed 21/21 cases in five files, with
`sourceStable: true`, in **43.41 seconds** against
`909ee29bdca76c6b2e1666cbee8f7c523484902a`. Temporary comment-only edits selected
those files; all comments were removed before pruning. Original files, JSON
results, phases and load samples remain under `.local/vuh-1925/menu-before-*`.

Main subsequently advanced. This batch is based on fetched current main;
additional reviewed voice/persona/project files enlarge the cut, and the private
helper changes native import-based selection. The baseline and landing gate
therefore are not a matched speedup comparison. No extra timing run is performed.
The committed-head root gate passed **36/36 cases in all eight edited files**
in **38.52 seconds** (39.56 seconds including command startup), exit 0,
`sourceStable: true`, Knip and TUI typecheck green. Checked HEAD:
`d8304c59e13102f6023adb0a9e841144bc3cbab3`; pinned base:
`501922c9c0d54c7d07a807afcd63264072115979`. That green gate authorized the
push to main.

Baseline and landing JSON/logs/load samples, per-file counts and export-only
proof live in the archived capture bundle listed in `evidence.json`:
`clankie://evidence/sha256/f904fedbf4ffae02dc2e589b4461a5ee0eab5c2317f99c7d8ce9a2350094ce60`.
Raw bytes stay outside git.

The per-file before/after counts and final root evidence are attached to
[VUH-1925](https://linear.app/vuhlp/issue/VUH-1925). Its final cumulative tally
will be posted only when the inventory is complete; this batch does not claim
completion. No deployments or evaluations are performed.
