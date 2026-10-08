# PC original-session refresh (VUH-1742)

This source change builds on local Codex correction `de3eca0c` and Claude cache
delivery `3407a76a`; neither commit solves legacy PC original-session migration.

## Corrected claim

Remote Claude formerly could return `refreshed` when an authenticated bridge
reported the requested runtime and the original root reported matching tools.
That does not prove replacement of the already imported mod or adoption by all
loaded descendants. The pinned path has no replacement operation with that
proof. At idle it now returns
`original_remote_claude_imported_bridge_refresh_unsupported` without publishing
a refresh signal. Busy original sessions still defer. Local current Claude
list-change observation and local managed Codex refresh keep their existing scope.

The regression crosses the real operator CLI, HTTP route, production refresh
coordinator and response schema. Native roster/catalog/bridge observations are
explicit surrogates, including apparently healthy root evidence that previously
allowed success. It proves refusal and zero signals; it does not prove native
PC adoption. [checks.txt](checks.txt) records the relevant checks.

## Read-only PC observations

SSH used `volpe@supedupsilly`, with PowerShell `-NoProfile -NonInteractive` and
encoded read-only commands. It read Herdr session/agent lists, plugin manifests,
selected registration fields and file hashes. No authentication files, bearer
values or process command lines were printed. No hire, turn, reconnect, reload,
configuration write, installation, restart or receipt operation was issued.

The original `default` Herdr session was running, with six listed agent panes;
other retained sessions were stopped. The installed worker manifest and both
Claude user registrations were `0.6.9`. Both current cache mod hashes were
`341405b98f4d1a2e2a8e074864ab0a78cf221a326f4730608a9f2edbe70ebbfa`, matching
the fixed source. Older caches remain, and the second profile retains a project
registration at `0.6.1`. These are installation facts only; no loaded-mod root,
original native thread catalog or descendant inventory was inferred from them.
An account Codex config still exists; only its timestamp/hash were read.
Detailed read-only metadata is retained in the worktree's ignored `.local/vuh-1742/`.
Initial inspection commands hit harmless metadata/query errors (read-only HOME
variable, unsupported `agent list --json`, missing old-cache mod). Corrected
queries succeeded; these errors are not refresh or authentication failures.

## Remaining acceptance

VUH-1742 remains open. No same-controller legacy migration has been claimed.

- Existing remote Codex cannot acquire private config provenance by editing an
  account-wide file. The current registry remains in memory; future managed
  private-home preparation and durable original-controller recovery are still
  required, including exact home/thread binding and no reconstructed authority
  from PIDs alone. This patch does not implement those pieces.
- Claude needs a supported native original-controller operation, or a reviewed
  migration that retains the required context/identity and verifies imported
  code plus every relevant loaded descendant at a safe point. Root-only reports
  and cache updates are insufficient. This patch adds safe diagnosis only.
- Retained report IDs, fingerprints and claims must reconcile read-only once;
  uncertain reports must never be replayed, deleted or replaced. Existing
  receipt implementation is unchanged; local receipt checks are separate from
  live PC proof.
- Live PC proof must retain original identities through busy deferral and idle
  adoption, show enabled peer tools, settle an exact fenced original receipt,
  then store a distinct deliberate new report. It requires owner-authorized
  access beyond the current portal scope. No PC hires/configuration changes
  are authorized here, and no hosted deployment was performed.

The [manual original-session proof](../worker-tool-refresh/manual-proof.md)
and [ADR 0235](../../adr/0235-worker-catalog-refresh-keeps-the-original-controller.md)
remain the proof contract. Unsupported reasons do not satisfy migration or live
adoption acceptance.
