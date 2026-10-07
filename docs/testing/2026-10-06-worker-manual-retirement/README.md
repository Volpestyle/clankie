# VUH-1739: current refresh and manual legacy retirement

The owner selected no automated restart for pre-0.6.5 local Codex seats. Current
managed controllers refresh in place; legacy seats keep the deployed safe
refusal and `restart needed` diagnosis and retire naturally. The lead may close
an idle seat and hire a fresh worker after retaining its handoff and settling
original receipts. Original thread evidence remains on disk. Remote PC/Claude
recovery remains VUH-1742. The rejected supervised restart candidate is not part
of this change.

[Retained results](result.json) record the deployed `c72c3d02` healthy update and
a fresh actual installed one-seat refresh request. The current worker was busy:
`skipped-busy: original_codex_thread_or_descendant_busy`. No quit, restart, report
POST, or receipt replay was requested. The prior owner-authored
[live refresh/report observation](https://linear.app/vuhlp/issue/VUH-1739#comment-e43b686f-e068-4022-a903-cba25a56053a)
records supported current-seat in-place refresh and recovery of its formerly
fenced report. This reuses that earlier observation for unchanged controller
behavior; it is not a new idle-success canary. The deployed updater's
`harnessRefresh.ok=false` installer result is not native refresh success.

Fresh focused checks passed 17 cases, including the explicit real owned Herdr,
HTTP and installed-CLI refusal case. Its original shell PID remained unchanged,
with no close/hire/history effect. The other existing integration cases cover
receipt guards, canonical targeting, busy handling and early
`native_exit_unavailable` refusal; they do not claim a live old-plugin restart.
Service typecheck, scoped lint and documentation link/retired-claim checks pass.
Raw evidence is `.local/1739/manual-retirement-checks.log` and the owned
`native-*` folder.

The [manual retirement path](../worker-tool-refresh/manual-proof.md#pre-065-local-codex-manual-retirement)
is the accepted legacy workflow. No new exit or guarded-input capability is
needed. Closure applies to the revised scope, not the rejected automatic
same-thread restart acceptance.
