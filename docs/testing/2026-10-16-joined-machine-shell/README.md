# Clankie's own shell on a joined machine — VUH-2319

Tracks: [VUH-2319](https://linear.app/vuhlp/issue/VUH-2319). Based on `origin/main`
at `912bdba9e`. Decision: [ADR 0244 amendment](../../adr/0244-machines-join-clankie-at-an-access-level.md).
Usage: [CLI join and `machines shell-audit`](../../cli.md#join).

## Outcome

A joined machine's `shell` level used to grant nothing beyond `workers`, because
nothing on the home ever dispatched a shell request. Clankie now has
`joined_machine_shell`, built to the lead's five conditions:

1. **Live level on every call.** Each call runs only when the machine's live,
   owner-approved level is `shell` or `screen`, rechecked with no cached grant.
2. **Receiver guarantees, each tested.** These are the approved ceiling,
   approved folders, output and time bounds, single execution, and stopping on
   revocation or a lowered level mid-call.
3. **Audit before effect.** Every call is recorded before anything leaves the
   home: lane, conversation, machine, folder, command SHA-256, outcome and
   reported exit. A call that cannot be recorded does not run. The audit is
   readable through `GET /v1/machines/shell-audit`, `clankie machines
shell-audit` and doctor (`joinedShellAudit`).
4. **Owner console only.** The tool is offered only in the owner console lane
   with machine tools: never Discord (owner-only rooms and DMs included), and
   never peer seats or MCP banks.
5. **Independent review.** A native review focused on escalation and bypass; its
   findings are below.

## Tests

All are in `apps/clankie/test/machine-join.integration.test.ts`. Each runs through
the real receiver, the real join channel over HTTP, and a real `/bin/sh`.

| Guarantee                          | Test                                                                                                                                                                                   | Fails when sabotaged                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Live level per call; audit content | runs at shell, refused after lowering to workers, runs again after restoring; audit holds lane, conversation, machine, folder, digest, exit and outcome; no command text in the ledger | —                                         |
| Ceiling                            | approved at `workers`: raising is refused and the shell is refused; nothing runs                                                                                                       | —                                         |
| Folders                            | the parent folder, a sibling folder and a symlink escape all give `directory_refused`; nothing is written                                                                              | —                                         |
| Output and time bounds             | 20 000 characters are truncated with the exit header kept. `(sleep 1; touch late) \| cat` stops at the limit and no grandchild survives. Output cannot forge the exit                  | kill only the shell → **fails**           |
| Single execution                   | channel responses are dropped until the home has claimed the request, then normal polling runs for the rest of the home's wait; the command never runs                                 | home re-delivers claimed work → **fails** |
| Revocation mid-call                | removing the machine during `(sleep 1; touch finished) \| cat` stops the whole group; later calls are refused                                                                          | kill only the shell → **fails**           |
| Lowered level mid-call             | lowering to `workers` during the same command stops it                                                                                                                                 | kill only the shell → **fails**           |
| No audit, no effect                | an audit file replaced by a symlink makes the call throw before anything is sent                                                                                                       | —                                         |
| Owner-started turns only           | an autonomous turn is refused with no dispatch, no access observation and a single `refused` record with origin `autonomous`; an owner turn on the same session then runs              | refusal disabled → **fails**              |
| Unknown outcome                    | a result that never arrives is reported `unconfirmed` and audited `unknown`, not `failed`                                                                                              | —                                         |
| Lanes                              | the owner console with machine tools gets the tool. Without machine tools, in any Discord or gameplay lane, or in the console with a Discord access plan, it does not                  | —                                         |

The focused join, seat, screen and machine-access suites pass, including 17 join tests.

## Independent review (escalation and bypass)

**No lane bypass found.** The tool is unreachable from:

- Discord rooms and owner DMs;
- room forks;
- the gameplay lane;
- MCP tool banks;
- joined seats and remote leads;
- peer seats;
- evals.

The only sender of `kind: "shell"` is this tool. Level checks, the audit file
(symlink, hard link, mode, torn line), paths and the machine id pattern held up.

**Fixed after the review:**

- Revocation and the time limit killed only `/bin/sh`, so subshells and
  pipelines kept running. Commands now run in their own process group, which is
  killed as a whole; a process tree on Windows.
- The audited exit could be lost to truncation or forged by output. The
  receiver's own exit line now comes first.
- The lost-delivery and revocation tests could pass vacuously. Both now fail
  under sabotage (table above), and a test for lowering the level mid-call was
  added.
- The docs said commands are confined to approved folders. They now say the
  command starts in an approved folder and the shell is not an OS boundary
  (VUH-1804).

## Lead review

The lead verified conditions 1–5 and required four fixes, all made:

1. **Untrusted turns.** The tool refuses any turn the runner marks autonomous:
   autonomy, Linear hooks and worker reports. The refusal is the only side
   effect. Every record carries `origin`. Input steered into an owner's running
   turn still inherits owner status, and the docs say so.
2. **Windows cleanup.** There is no tree kill after the shell exits: no tree
   remains and the PID may be reused. The tree kill while the shell is running
   stays. Known limits, documented: Windows children left after exit, and POSIX
   `setsid` escapes.
3. **Audit accuracy.** When no result arrives in time, the home settles
   `unconfirmed` and the audit records `unknown`. That covers the 45-second wait
   and results the receiver drops past its 16-result queue.
4. **Docs.** The command text stays in the conversation's session transcript,
   so storing only the digest is a convention, not secrecy.

## Open

- **Screen without consent.** At `screen`, the shell can reach the screen
  through the machine's own permissions without the per-session screen consent.
  That follows from `screen` including `shell` and is documented. Screen-only lending is
  [VUH-2321](https://linear.app/vuhlp/issue/VUH-2321).
- **Older receivers and load.**
  - An older joined receiver reports success only for exit 0, and its output
    could start with a forged header.
  - The receiver still refuses past 16 concurrent requests.
  - Stopping a turn does not cancel a dispatched remote command.

**Not run:** a real-gateway scratch-stack proof of the tool. The channel and
gateway path were proven under VUH-1800; this tool adds only home-side dispatch
and receiver execution, which the tests above exercise over real HTTP.
