# VUH-1478: the channel delivered; transcript filtering lost its receipt

James's post-restart probe did reach Claude through `clankie mcp --seat`. The
native session `abcdbf23-568a-43a5-a145-857d69472728` contains the full brief in
a user record at `2026-09-30T19:06:54.494Z`, inside a
`<channel source="plugin:clankie-worker:swarm" ...>` envelope. Its event ID is
`seat-9c4e8a2e-8cf4-45e5-a15a-44b1def66d37`. Haiku answered `PROBE OK` at
`19:06:56.249Z`; the worker Stop hook recorded that same reply at `19:06:56.987Z`
for pane `w2H:p7B`. The service nevertheless reported `brief_delivery_unverified`
and closed the pane.

The envelope and complete brief match what the verifier expects. The missing
piece is in `@clankie/agent-transcript`: Claude stamps channel user records with
both `isMeta: true` and `promptSource: "system"`. The reader opts into internal
channel receipts, but its metadata filter discarded the record before reaching
channel handling. The old adapter tests supplied already-normalized messages
without traversing that filter, so they missed the defect.

The parser now recognizes user channel envelopes before excluding other
metadata. These remain `internal: true` receipts; ordinary transcript parsing
and operator-history uploads still hide them. The verifier still requires a new
record containing the complete brief, and no terminal resend is added.

## Evidence

- [Native replay](native-receipt-replay.json): selected fields from the original
  live receipt and the corrected production reader's output. The exact channel
  body now matches; public messages contain only `PROBE OK`. The original
  journal is untouched. No prompt snapshots or unrelated session context were
  copied into this artifact.
- [Regression before the fix](receipt-before.txt): both new tests fail with
  `outcome: failed` through the original parser.
- [Focused tests](receipt-focused.txt): 94 hire/transcript/seat-sync tests and
  15 MCP bridge tests pass. The new tests use the production Herdr transcript
  reader and worker adapter against a temporary native JSONL file. They cover
  string and text-block content, system metadata flags, intervening instruction
  attachments, a second identical message requiring its own new receipt, and
  hidden metadata/public-channel entries. Process launch and mailbox transport
  are test doubles; actual transport delivery is established by James's saved
  channel event and reply above.
- [Repository checks](receipt-checks.txt): `pnpm check` initially stopped on
  another lane's formatting change in `docs/README.md`; the remaining gates
  were run separately and passed: lint, dead-code, docs, infrastructure,
  typechecks, 384 Vitest files (3,254 tests passed, two skipped), 123 Rust tests,
  and Vox IPC smoke. All changed source/docs files pass `oxfmt --check`.

Zero additional hires were used. No seats were created, and no service restart
or push was performed. Post-fix success through the running `hire_agent` tool
still needs James to restart onto this follow-up commit. One Haiku hire in the
already-trusted repo, a one-line brief, and cleanup of the returned seat are
sufficient; inspect the channel receipt and `control.mode: "channel"`.
