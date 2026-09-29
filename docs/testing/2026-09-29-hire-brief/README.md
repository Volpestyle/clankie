# Verified hire briefs — VUH-1450

[VUH-1450](https://linear.app/vuhlp/issue/VUH-1450) was reproduced on 2026-09-29
with real Claude Code and Codex seats in empty scratch directories, using the
production `HerdrWatchStore` / `createHerdrWatchRunner` code directly. No running
Clankie service was restarted or replaced. All created panes were closed;
`w2H:p5G` was not read, messaged, or changed.

## Root cause and delivery path

`lane-tools.ts` exposes `tools.ts`'s `hire_agent`. Previously Claude passed through
`captain.ts`'s `hireSeat` into `HerdrWatchStore.spawnSeat`, then `messageSeat` →
`sendToSeat` → mailbox when bound, otherwise `pane send-text` + `pane send-keys
Enter`. That raw text command writes bytes without bracketed-paste framing.
Claude lost the beginning even after its input was ready. A successful write
and a status change were incorrectly treated as delivery. Codex's first brief
already used Herdr's paste-aware `agent prompt` because it needs a first turn to
report its session identity.

With the fix, all initial briefs use `agent prompt` after `agent start`'s
readiness wait. A full operator transcript message must match before delivery
is reported, including the payload of Claude's native `pasted_content` envelope.
Partial text, assistant echoes, absent receipts, and read failures cannot become
`delivered`. A missing receipt returns typed `not_ready` with
`brief_delivery_unverified` and closes only the newly created pane. No prompt is
automatically resent. Follow-up PTY delivery also uses `agent prompt`.

Herdr 0.9.1 also reported Codex's folder-trust dialog as ready in the scratch
runs. Sending a brief there consumed Enter as the trust answer and lost the
brief. The fix rejects this known dialog before submission. For the successful
scratch test only, the driver explicitly trusted its own newly created empty
folder and waited for the input prompt. Production does not grant trust.

## Real transport evidence

The [synthetic brief](brief.txt) is 4,486 UTF-8 bytes. It asks for the beginning
and ending markers, forbids tool use, and includes 55 numbered filler rows.
[comparison.json](comparison.json) compares the full payload, independently of
model replies, and records SHA-256 hashes.

| Run                      |            Received | Result                                                                | Native transcript            |
| ------------------------ | ------------------: | --------------------------------------------------------------------- | ---------------------------- |
| Before, Claude Sonnet    |   397 / 4,486 bytes | `sendToSeat` returned true; 4,089 bytes lost, starting inside row 050 | [before](before-claude.json) |
| After, Claude Sonnet     | 4,486 / 4,486 bytes | Hire succeeded after full receipt; equal SHA-256                      | [Claude](after-claude.json)  |
| After, Codex GPT-6-Astra | 4,486 / 4,486 bytes | Hire succeeded after full receipt; equal SHA-256                      | [Codex](after-codex.json)    |

The passing seats were `w2H:p5Q` and `w2H:p5V`; the original failing seat was
`w2H:p5M`. Startup experiments were also cleaned up; the final pane census
contained no scratch test seats. The transport fix was tested from source,
without changing the installed Herdr 0.9.1 server or restarting Clankie.

## Regression coverage and limits

Focused tests exercise the actual captain tool bank with a fake Herdr CLI, plus
controlled readiness and receipt failures: delayed startup, delayed transcript,
Claude and Codex long unicode briefs, missing prefix, missing suffix, absent
transcript, assistant echo, native paste envelope, blocked startup, and Codex's
misclassified folder-trust screen. Hires submit once; rejected hires close only
the pane they created. The existing slow Codex first-turn session test remains.

The native transcript projection is redacted and limited to 16,384 characters.
When those limits prevent an exact match, the hire fails explicitly; use a brief
file and short pointer. Other harnesses without readable native transcripts also
cannot claim verified brief delivery. A failure can occur after a turn starts,
so inspect any work before retrying. This patch verifies initial hire receipts;
follow-up mailbox and Codex queue acknowledgments retain their existing semantics.

A pre-existing full-check failure was an unregistered, committed browser smoke
driver. `knip.json` now declares that documented standalone driver as an entry,
matching the neighboring evidence drivers. Its code was not changed.

Re-run:

```sh
pnpm exec vitest run apps/clankie/test/hire-brief-receipt.test.ts apps/clankie/test/hire-brief.test.ts apps/clankie/test/herdr-watch.test.ts apps/clankie/test/herdr-startup.test.ts
pnpm check
```

Final `pnpm check`: exit 0; 361 TypeScript test files, 3,079 tests passed
(2 skipped), 123 Rust tests passed, and Vox IPC smoke passed. See
[check-summary.txt](check-summary.txt).
