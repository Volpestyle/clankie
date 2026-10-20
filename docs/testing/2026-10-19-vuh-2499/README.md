# VUH-2499 — lost Claude hire briefs and startup ownership

Tracks: https://linear.app/vuhlp/issue/VUH-2499

The local root causes are established. The precise upstream Claude channel drop
is unproven.

The bridge acknowledges a notification after writing it to MCP stdout.
`ClaudeWorkerSeatControl.send` used to return that object receipt immediately,
bypassing the native transcript check. Startup treated a polling bridge as ready,
sent the first brief through it, and returned `started` without a native prompt.
The hire layer then reported `consumed` / `brief.outcome: delivered`.

Juno's retained lead tool receipt says consumed at **22:15:40.480Z**, but her first
native queue enqueue and user prompt are the rescue `message_seat` at
**22:15:56.703Z**. Marek likewise has no original prompt: his first queue/user
record is the rescue at **10:26:03.167Z**. The missing prompts and overclaimed
receipts are proven; the specific Claude handler-registration race that discarded
the early writes is an inference, not a reproduced upstream defect.

The independent ownership defect was that the Claude adapter never called
`view.bound`. Ownership was bound only after successful startup. kit-bc67's
retained hire receipt has its original pane and brief fingerprint, but no session
or occupant; the owner journal still has a pane-only pending claim. Its native
transcript has no user or assistant turns. Its persona conversation, created on
October 19, is revision zero and `sessionState: unbound`, with a native source
pointing to the original October 17 session. It did not lose a saved session
owner; startup never promoted the persisted allocation claim to that owner.

```mermaid
sequenceDiagram
  participant H as Hire controller
  participant C as Native Claude TUI
  participant B as Channel bridge
  participant L as Hiring conversation
  H->>C: Start with brief as native CLI prompt (once)
  C-->>H: Observed native session
  H->>H: Retain session ownership before readiness waits
  C->>C: Take native prompt after startup
  H->>C: Read exact complete prompt from native transcript
  alt Prompt observed
    H-->>L: Consumed
  else Prompt unconfirmed or startup fails
    H->>H: Keep original receipt and durable failure summary
    H-->>L: Existing worker-watch wake; uncertainty, no replay
  end
  Note over B: Channel remains for resumed briefs and follow-ups;<br/>stdout ACK alone cannot confirm a native prompt
```

Fresh hires now submit the brief once as Claude's native CLI startup argument.
They never additionally send it through the channel. Resumed briefs and
follow-ups require a complete native transcript receipt before reporting
acceptance. Slow transcript persistence retains uncertainty and the original
fence; later inspection can reconcile it without another launch or send.

The adapter binds observed native identity even when Herdr's startup wait fails.
The hire controller retains that identity before project-readiness proof checks;
this is historical ownership, not new native admission. Failed startup writes a
persistent roster summary and uses the hiring conversation's existing watch wake
callback. A pending allocation without a native session remains a pending claim,
with a failure flag and no manufactured native control.

## Proof

- **Real native TUI:** source adapter, Claude Code **2.1.304**, Haiku 5.5, medium,
  in owned Herdr panes, **23:23:11–23:24:18Z** and **23:30:24–23:30:38Z**. Each exact native transcript
  contains **one** complete brief, **zero** channel copies, and assistant reply
  `VUH2499_NATIVE_FIRST_TURN_OK`. The adapter's mailbox implementation would
  throw on any attempted fallback. Both panes were closed after capture. The second run records hashes of the source inputs at capture in `native-final.json`.
- **Regression integration:** real adapter, parser, and durable hire/owner stores,
  with process discovery/launch supplied at the existing runner seam. Covers
  stdout ACK without native acceptance, fresh startup with no channel send,
  missing first prompt, launcher timeout after launch, persisted ownership and
  roster failure flag across restart, original-conversation wake, changed-session
  refusal, and late native transcript reconciliation with one launch/zero sends.
  These process observations are synthetic; the native TUI proof above is real.
- **Focused checks:** **69 tests passed** in four files; focused compilation of all touched source/tests and file-scoped lint/format checks passed. Recorded in `focused-tests.log` and `focused-typecheck.log`.
  The first broad app typecheck found test-fixture typing errors; those were fixed.
  The assigned integrator supplies the exact-tree landing gate.

## Landing-gate follow-up

Rebased onto `dd6647b39`. The deadline timer's abort rejection now documents why
it can be dropped; startup-wake failures log a redacted diagnostic while keeping
the durable failure summary. `node scripts/check-swallowed-rejections.mjs dd6647b39`
passed over 135 added code lines, and the two focused Claude startup/seat test
files passed all 47 tests. The native-start captures above are retained evidence
from the original implementation; the follow-up changes deadline cleanup and
wake-failure diagnostics.

The subsequent five failing tests exposed one product regression and two stale
watch setups. Preparation failures now return `not_sent` before native startup
is attempted, instead of spending 30 seconds waiting for a nonexistent session.
The watch fixtures now explicitly resume their existing session for channel
follow-ups; their Stop-correlation assertions are unchanged. Both requested files
(`herdr-watch.test.ts`, `remote-claude-isolation.test.ts`) passed all 100 tests,
and the original Claude startup/seat files passed all 47 tests. The swallowed
rejections check passed over 144 added code lines against `dd6647b39`.

## Limits

No production service restart, deployed runtime repair, remote Windows Claude
proof, or upstream Claude source-level reproduction was performed. The evidence is
two real fresh native adapter starts, plus deterministic regression coverage. Successful
local hire/outbox receipts were already pruned; Juno's original consumed result
survives in the lead conversation. Marek's consumed claim is the issue's report;
his missing native prompt and later rescue are independently inspected.

Raw captures are in the evidence store referenced by `evidence.json`. They are
sanitized projections of runtime journals and the owned native proof, without
credentials, private brief contents, or system prompts.

[Sanitized traces, both native starts, driver and check logs](captures.tar).
