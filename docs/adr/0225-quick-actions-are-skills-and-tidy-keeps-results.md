# ADR 0225: Quick actions are skills, and tidy keeps results

Status: proposed for review (2026-10-04; VUH-1660).

Extends [ADR 0200](0200-clankie-bundles-its-opinionated-skills.md) and
[ADR 0207](0207-work-records-and-native-agent-delivery.md).

## Decision

A skill may declare `quick-action` frontmatter: `name`, a lowercase `icon`
identifier, and optional `selectionArg`. Valid declarations accompany skills in
the existing composer catalog, when `includeQuickActions` is requested. New history
fields require `includeClosedPanes`; older strict clients retain their original
response shapes. Invalid declarations leave the skill usable and
omit its action. A surface submits the skill's existing invocation, with optional
selection context; it does not execute a separate automation. `/tidy` goes through
the TUI's ordinary visible, interruptible conversation turn. The hosted TUI reads
its selected conversation's catalog. App presentation is a later change.

The `tidy` skill is authored in the skills repository and exported from its
committed revision. It follows the existing opinionated selection switch. It
teaches Clankie to inspect and harvest work, judge which panes are finished, use
`close_worker_pane`, and say what he closed and why. It may be used after harvesting
without a separate owner tap. Status is context, never a service done filter.

The service has exactly three policy refusals: `unsent_draft`, `owner_interactive`
(the pane was not hired by Clankie), and `results_not_kept`. Unreadable input,
uncertain hire/session provenance, unavailable native control, and uncertain
close/resume outcomes are typed technical failures. Adopting a hand-started pane
never converts it into an actual hire. New hire records retain that distinction;
legacy records need historical launch proof or return `provenance_unknown`.

Before closing, copy a verified nonempty saved report into private service-owned
storage, retain the last output, and persist a close-intent row. Authenticated
accepted worker reports are also saved artifacts; queued delivery is not claimed
as delivered. History retains the one-line reason, output, report path and Undo
window in the fleet snapshot and `worker_pane_history`. Physical pane removal uses
the existing native close path, including its prepared-controller protections.
Fresh native identity and styled input are checked again at the final guard.

`undo_worker_pane` reopens and resumes the exact native session through the ordinary
hire path, preserving its original conversation owner, within five minutes. It
requires confirmed close, current authority in the closing conversation, and no
other live TUI for that session. Uncertain closes or resumes retain pending history
and block automatic replay. A new pane/terminal id is expected after Undo.

A reattached Codex TUI without a Herdr `agent_session` can establish identity from
its live foreground process's explicit `resume <UUID>` argv, or a native rollout
file. The historical session must still match an actual persisted hire. Bare pane
ids, persona labels, `resume --last`, and prepared-pane records cannot grant that
permission. This does not broaden worker bridge admission or repair VUH-1657's
roster binding recovery.

## Styled input evidence and limits

Herdr `pane read --source visible --format ansi` preserves cell SGR attributes.
A live Claude Code 2.1.289 disposable pane showed a variable ghost suggestion as
faint SGR 2 and a typed, unsubmitted draft as ordinary cells. Its current input is
identified by the bottom prompt between horizontal rules; uniformly faint content
inside that structure is a ghost. A live Codex disposable pane showed its known
placeholder as faint SGR 2, while typing the identical placeholder words produced
ordinary cells. Codex requires both the known placeholder and faint styling.
Plain text alone, unsupported input shapes, italic-only ambiguity and unsupported
harnesses return `draft_state_unknown`. Golden fixtures preserve these live input
regions. No owner's pane was typed into or closed for verification.

An earlier label calling the faint suggestion in `w3Z:p2J` a real draft was wrong
and was withdrawn. That read observed a ghost; the disposable pane supplied the
actual typed-draft control. Four idle observations (existing and disposable Claude
and Codex) had zero unknown results; both disposable typed controls were drafts.
This is a small version-specific sample, not a fleet-wide reliability estimate.

There remains a read/close race: an owner can type after the final styled snapshot
and before native close. The stronger Herdr/harness primitive is a conditional
close bound to input revision/native draft state, or a native draft-state read
paired with such a condition. That primitive is outside this change. Unknown
reads and provenance fail closed; this change does not claim atomic draft safety.
Actual model-driven close/Undo on an owned hired session remains a live canary;
focused integration fixtures exercise the service, journals and native adapter
boundary without closing the owner's fleet.
