# VUH-1782: Claude Code hook answer spike

Recorded 2026-10-07. Installed native Claude Code: `2.1.293`, resolved by
`claude --version`; executable is `~/.local/share/claude/versions/2.1.293`
(Mach-O arm64), reached through `~/.local/bin/claude`.

## Result and mechanism

The [official hooks reference](https://code.claude.com/docs/en/hooks#tools-that-require-user-interaction)
documents answering `AskUserQuestion` through `PreToolUse`: return
`permissionDecision: "allow"` and `updatedInput` containing the original
questions plus `answers`, keyed by question text. Selected labels are the values;
multiple selections join labels with commas. Allow alone does not answer.

[PermissionRequest](https://code.claude.com/docs/en/hooks#permissionrequest-decision-control)
accepts `hookSpecificOutput.decision.behavior` of `allow` or `deny` (optional
denial `message`). Its input has no `tool_use_id`. Deny rules remain effective.
Sandbox network prompts are outside this hook.

Choose synchronous command hooks that register a structured request, wait for an
answer through the harness channel, then return the hook JSON. Keep the original
session and input snapshot. Clankie exposes stable request/question IDs; the
bridge translates those IDs into Claude's text-keyed answer object only at
delivery. Give permission-hook invocations their own IDs. Refuse duplicate
question text within one call rather than losing a question during translation.

Interactive sessions ignore `defer`. Async hooks cannot decide permissions.
Timeout, disconnect, cancellation and stale IDs must never imply approval.
Other hooks and permission settings may still prevent execution.

## Installed implementation evidence

A read-only scan of the native executable's embedded JavaScript corroborated
the documented fields without running a model or steering an existing lane:

- Byte offset `200127418`: AskUserQuestion input schema includes optional
  `answers`, described as answers collected by the permission component.
- Byte offset `200128725`: result schema describes question-text keys and
  comma-separated multiple selections.
- Around byte offset `200133800`: the actual tool `call` reads `e.answers`,
  looks up each question's answer by `t[l]`, and returns questions and answers.
  The tool-result formatter subsequently constructs the answered-questions
  message from that same map.
- Byte offset `192689971`: permission-hook output handling recognizes
  `PermissionRequest`, `decision.behavior`, `updatedInput`, denial `message`
  and `interrupt`.

These offsets identify the inspected installed binary, not a portable API.
No executable code or session contents were copied into the repository.

## Verification boundary

Tested: the installed version command and executable inspection. Documented and
statically corroborated: both response mechanisms. **Not tested:** a real
interactive Claude tool invocation consuming the answer, hook timeout behavior,
or user-versus-hook races. No `claude -p`, new worker, pane typing, restart,
account change or live permission approval was used for this spike.

The selected mechanism should receive an integration check at the plugin/host
boundary with the real command hook, including stable IDs, answer consumption,
duplicate-answer rejection, timeout and cancellation. That check establishes
Clankie's transport behavior; it must not be described as a live Claude TUI
acceptance test. Live acceptance remains a separate authorized lane check.
