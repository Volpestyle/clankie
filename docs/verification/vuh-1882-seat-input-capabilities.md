# VUH-1882: service input capabilities

James assigned the service contract separately from the app composer and
VUH-1883 Send-to-Stop UI. The roster now publishes optional `inputCapabilities`
with `deliveryModes`, exact-task `interrupt` support and Claude `nextTurnOnly`.
The [protocol guide](../../packages/protocol/README.md#seat-input-capabilities-vuh-1882-service-contract)
is the app worker's contract. ADR 0207 records James's scope and the lead's
implementation decision. The issue stays open for the separate app work.

The support check runs before explicit dispatch and receipt substitution.
Next-turn-only Claude offers Queue, refuses Steer without storage, and loses
its old receiver evidence when the native occupant changes. A generic mailbox
does not grant a native input mode. Capabilities do not grant authorization;
Stop retains its exact-task and authenticated-owner checks.

## Verification

- Twelve new boundary cases cross the real watch/control fence, durable
  next-turn and live mailboxes, and public roster schema. Recorded native
  controller declarations cover owned/unowned Codex, live/next-turn/unverified
  Claude, OpenCode, Pi, Grok and mailbox-only seats. Additional cases cover
  unavailable endpoints, absent queue routes, occupant swaps, Stop authority
  revocation and old-reader additive-field compatibility.
- Focused capabilities/native chat/fence/protocol/response run: 73 passed across
  five files. Native chat also checks the captain publishes the new field.
- Full no-bail five-file delivery consumer gate: 86 passed through `clankie heavy`.
- Real Codex hired-controller protocol integration: 16 passed. The guarded
  installed/PC lane was not enabled (12 skipped); no PC input or model eval ran.
- Heavy service and protocol typechecks, scoped formatting/lint and documentation
  links pass.

The broader OpenCode lifecycle fixture failed all 20 cases during startup:
local tab naming expected the persona label but received `native`/workspace
text; remote cases reported unavailable native operations. With all VUH-1882
changes stashed, unchanged main `40cd778a` failed the same 20 cases. This is
baseline evidence, not a passing OpenCode lifecycle claim. Raw baseline log:
`.local/claude-proof/vuh-1882-opencode-baseline.log`. Those startup failures
precede the capability/delivery boundary. After rebasing onto the independent
VUH-1869 fixture corrections (`a8faeafd1`, `001a1072a`), all 20 OpenCode lifecycle
cases pass, with the 12 capabilities and two native chat cases (34/34 total).
Raw passing log: `.local/claude-proof/vuh-1882-after-rebase.log`.

No app UI, deployment, dotfiles or existing panes were changed.
