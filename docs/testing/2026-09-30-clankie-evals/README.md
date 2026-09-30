# VUH-1454 — isolated subscription eval baseline

Date: 2026-09-30. [Issue](https://linear.app/vuhlp/issue/VUH-1454).
[Run guide](../../evals.md). No push, deployment or live-service restart was part
of this work.

The suite contains twelve reduced coding/UI/research fixtures derived from recent
repository commits and six synthetic Discord/voice cases. This deliberately small
baseline samples the `current` arm: the versioned Clankie instructions and bundled
skills. It does not replay the complete service, private conversations, or the
owner's personalized settings. No plain/trimmed comparison was purchased yet.

## Recorded results

| Harness / model                   | Case              | Check                                  | Wall time | Reported tokens | Rework |
| --------------------------------- | ----------------- | -------------------------------------- | --------- | --------------- | ------ |
| Codex 0.159.1 / gpt-6-astra       | memory-card       | PASS                                   | 44.243 s  | 102,035         | 0      |
| Claude Code JS 2.1.0 / Sonnet 4.5 | memory-card       | FAIL: reset dedup                      | 19.817 s  | 78,171          | 0      |
| Claude Code JS 2.1.0 / Sonnet 4.5 | evidence-research | FAIL: eight-turn limit, missing answer | 25.545 s  | 149,014*        | 0      |
| Claude Code JS 2.1.0 / Sonnet 4.5 | discord-addressed | PASS                                   | 12.332 s  | 30,048          | 0      |

Codex completed one inference trial only. It recovered from one failed shell tool
call (heredoc temporary-file access); the runner now carries its isolated temporary
directory through Codex's shell environment. Claude had no reported tool errors.
Its memory fix returned true twice after reset. Its research run kept searching
for evidence files despite the evidence being in the prompt; it exhausted eight
turns without producing `answer.json`. Those are retained failures, not discarded
trials. The addressed synthetic social response passed the response/trust check.

Codex's 79,488 cached input tokens are included in its 101,154 input tokens, plus
881 output. Claude's three trials include 207,293 cache-read tokens and 45,267
cache-write tokens. Token counts are not subscription quota percentages or money.
The two-case Claude campaign passed its 120,000 between-call budget on its second
call and left the social case unrun. A separate explicit one-call campaign ran
that case. A single call can exceed the token budget; call count and timeout are
the hard bounds.

*The original research report records 146,197 tokens from `result.usage`. Inspection
found an additional 2,817 auxiliary Haiku tokens in `modelUsage`. The final parser
includes all reported models; the table uses that corrected 149,014 total. The
archived report remains unchanged so the correction can be audited against its
[events](claude-current-evidence-research/events.jsonl). Across these four trials,
the corrected token total is 359,268. No paid model judge or automatic repair ran.

## Artifacts and reproducibility

- [Codex report](codex-current.json), [check](codex-memory-card/check.txt),
  [deliverable](codex-memory-card/solution.txt), [events](codex-memory-card/events.jsonl).
- [Claude coding/research report](claude-current.json),
  [memory check](claude-current-memory-card/check.txt),
  [memory deliverable](claude-current-memory-card/solution.mjs.txt),
  [research check](claude-current-evidence-research/check.txt).
- [Claude social report](claude-social.json),
  [answer](claude-social-discord-addressed/answer.json.txt),
  [check](claude-social-discord-addressed/check.txt).
- [Native Claude startup failure](claude-native-startup.json): representative
  45-second timeout, unknown usage, before any recorded inference result.

Reports retain source revision, suite hash, instruction/skill hashes and runtime
identity. Later reports also include runner/binary hashes. Artifact paths were
made archive-relative, and Codex tool counters were derived from its saved events.
The local temporary directory paths inside event text belong only to these fixtures.
No credential homes, authentication records, owner conversations or private image
content are included.

The installed native Claude 2.1.285 repeatedly stalled at startup inside the strict
OS sandbox. Startup troubleshooting also tried native 2.1.284 and a JS run before
the FSEvents allowance was added; those unsuccessful probes had unknown usage and
are not quality trials. A separate tools-disabled JS OAuth probe returned `OK`
(2,031 reported tokens). The official `@anthropic-ai/claude-code@2.1.0` JavaScript
package then completed the trials above using subscription OAuth. Its recorded
initialization reports `apiKeySource: none`. It was unpacked into `/private/tmp`;
the owner's installed CLI and configuration were not replaced. The run guide has
the exact temporary installation procedure and `--cli` invocation.

The runner was hardened during verification: parent evidence files and directory
roots are protected from model writes, checker symlinks are removed before oracle
installation, refresh tokens are stripped, and Codex receives the isolated temp
environment. The separate social trial also removed a duplicate temp-environment
property. Reports preserve the runtime hashes at each execution; these sparse
samples are not a matched model comparison or grounds for instruction cuts.

## Validation

Six offline tests pass, including real macOS sandbox denial of outside reads and
writes, process signals, loopback access and evidence-file writes; fixture edits;
broken/passing checks; checker-symlink resistance; independent Git worktrees;
product-only skill selection; and token accounting including auxiliary models.

Validation of the complete shared checkout is recorded in `validation.txt`.
