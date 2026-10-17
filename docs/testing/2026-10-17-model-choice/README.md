# VUH-2108 / VUH-2110: model selection compatibility

Tracks: https://linear.app/vuhlp/issue/VUH-2108 and https://linear.app/vuhlp/issue/VUH-2110

Audited fetched core `origin/main` `45829f33a` and app `fb75199e`; both Oct 11 implementations are already on main (`0e579cc3e`, `9e6a6c948`; app `1db6e24b`, `d40ef584`). Both issues' comments and all attachments were read. [Acceptance-by-acceptance core audit](https://linear.app/vuhlp/issue/VUH-2108#comment-dd9a2eda-bd45-474e-92d3-68aa05e95718); [app audit](https://linear.app/vuhlp/issue/VUH-2110#comment-446237af-9dc9-40d4-99f3-46f72e01e6f3).

The core gap was the compatibility selector: `/v1/model-keys/select` called a setter that did not enforce the settings API's eligible choices. The shared setter now enforces current availability and hosted mappings for every caller. The legacy endpoint maps routine/escalation to an eligible `clankie/default` preference; the new endpoint still refuses tier choices. Existing persisted tier values remain readable until replaced by an eligible choice. Credential storage, provider authentication and spending rules are unchanged.

CLI/TUI now say “Rates not published yet” before selection. No approved rate/catalog policy exists; Clankie confirmed that VUH-2107/VUH-1890 alone retain `needs-human`. No prices, entitlements, paid model calls, evals, deployment or account changes.

## Verification

- Model-key/API checks: 17 passed, including real settings HTTP selection/reversal, unauthenticated/refused writes, legacy migration and unavailable included mappings.
- CLI/provider consumers: 35 passed on unchanged source inputs (7 CLI, 28 provider-command cases).
- An existing telemetry fixture now supplies an available fixture credential before selecting, so it still proves custom IDs and key material never enter telemetry while obeying the new eligibility boundary.
- Initial dependency-copy failures were setup failures (missing integration links and a copied lead-skin link to another app worktree), not passing product evidence. Repaired only this isolated worktree's links/copies; the held `~/dev/clankie` remained untouched.
- Root landing gate and current-turn HTTP proof pending. App/device evidence is retained in the private app's same dated folder.
