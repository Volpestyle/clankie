# Interactive Swarm channel probes — 2026-09-26

[VUH-1380](https://linear.app/vuhlp/issue/VUH-1380), held by the Claude Clankie
seat. [Proposed design](../../adr/0194-interactive-swarm-workers-receive-leased-channel-events.md).
These are isolated live transport experiments, not a shipped worker replacement.

## Results

| Probe                   | Observation                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle turn               | Herdr reported idle before notification. Model ack arrived 1,682 ms after emit.                                                                                                                                                             |
| Unsent draft            | Herdr changed done → working → done. The exact unsent draft remained in the composer; ack took 1,495 ms.                                                                                                                                    |
| Duplicate channel event | Same message ID was delivered again and acknowledged after 1,429 ms. Channel transport does not dedupe.                                                                                                                                     |
| Long tool               | Second event was emitted 48 ms into an 8,002 ms tool. It did not interrupt that tool. Its UserPromptSubmit hook ran 140 ms after tool end; ack followed 1,610 ms after tool end.                                                            |
| Real expired lease      | First attempt committed one durable effect but withheld ack. Expired-token ack returned `stale_delivery`. Attempt 2 kept the message ID, changed lease token, reused the effect and reached `acknowledged`. Exactly one effect commit.      |
| Credentials             | No operator/captain/worker-token environment variable in the initial transport bridge. The expiry bridge read only its own enrolled worker capability from a private fixture file. No Clankie operator broker or live coordinator was used. |

Claude Code was **2.1.283**, interactive **Sonnet 5**, **low** effort. The first three probes
used `--setting-sources '' --strict-mcp-config`, one explicit `swarm_probe` MCP
server, no built-in tools, and only its `ack` tool allowed. The scoped expiry test
used Swarm revision `6637756` from Clankie's vendor artifact. No production state
was upgraded or restarted. All owned probe panes and the disposable coordinator were closed. The consent
follow-up below installed two plugins at local scope in a temporary directory;
both were uninstalled and its temporary marketplace declaration removed.

## Inspectable evidence

- [Summary and limits](summary.json)
- [Idle, draft and duplicate timestamps](idle-and-draft.json)
- [Draft before delivery](draft-before.txt) and [after delivery](draft-after.txt)
- [Long-tool/channel timestamps](busy-and-hooks.json), [native hook sequence](native-hooks.json), and [terminal output](busy-screen.txt)
- [Lease expiry timestamps](lease-expiry.json) and [asserted receipt proof](lease-proof.json)
- [Receipt fixture source](receipt-fixture.mjs.txt): the exact test bridge with
  its machine-specific checkout prefix replaced by `<clankie-checkout>`.
  It is a review artifact, not an installed executable. Private enrollment files
  and actual lease tokens are omitted.

The fixture's controlled effect is one exclusive file creation keyed by the
stable message ID. The first receipt is deliberately withheld. Redelivery uses
the existing effect and acknowledges the new token. This is **not** a claim that
arbitrary model-authored effects become exactly once. Production operations need
their own idempotency keys or reconciliation.

## Reproduction outline

1. Create a private temporary directory and an MCP stdio server with
   `experimental['claude/channel']`, an ack tool and timestamp logging. Accept
   test events over a private Unix socket. Do not expose a public HTTP listener.
2. Launch interactive Claude with a fresh native session ID, isolated settings,
   the server config and
   `--dangerously-load-development-channels server:swarm_probe`. Confirm the
   explicit local-development warning in this owned probe session. No permission
   bypass flag, marketplace plugin, operator plugin or `--print` is used.
3. Observe Herdr idle before sending an event through the socket. Record both
   the notification write and actual model tool call. Do not submit terminal
   text or Enter as the event delivery path.
4. Enter an unsent draft without Enter, emit another event, and compare the
   composer afterward. Re-emit its ID to test transport deduplication.
5. Add native hook timestamp logging and delay one ack tool eight seconds. Emit
   the next event after `long_tool_start`, before `long_tool_end`; compare its
   hook and ack times. `UserPromptSubmit` fires for channel turns on this version.
6. For real expiry, enroll a leader and worker in a disposable Swarm coordinator.
   Send one peer message, fetch a ten-second lease and pass that envelope through
   the channel. Commit a durable effect but withhold ack. After expiry, verify
   stale ack rejection, sweep, honor retry backoff, fetch attempt 2 and re-emit.
   Assert stable message ID, changed token, one effect and final acknowledged state.
7. Close only the owned test panes and coordinator. Keep credentials and raw
   session artifacts private; publish only sanitized evidence.

## Readiness caveats

The [current official reference](https://code.claude.com/docs/en/channels-reference)
and this probe support bare-server development channels. The previous plugin-only
assumption does not hold for this version. This does not test `--plugin-dir` or
promise compatibility with older versions or all organization policies.

Each development-flag launch required the development confirmation. In addition, the banner
said “no MCP server configured with that name” despite successful notifications
and tool calls. Treat real channel receipt as readiness evidence; do not infer it
from that banner, MCP initialization, process existence or terminal idle alone.
For the custom Swarm channel, unattended startup consent remains an
implementation constraint; the approved-plugin control below does not solve it. Production task-heartbeat continuity, resume and fenced reconnects still
need integration tests.

## Marketplace and persistent-consent follow-up

See [machine-readable results](marketplace-consent.json), the
[approved plugin transcript](marketplace-approved.txt),
[unapproved plugin transcript](marketplace-unapproved.txt), and
[installed development-plugin dialog](marketplace-development-dialog.txt).

On the same personal Max account and Claude Code 2.1.283:

- Official `fakechat@claude-plugins-official`, installed at local scope, launched
  with normal `--channels`, reached idle without development confirmation and
  replied to `approved-001` through its real reply tool in **1,890 ms**. Its
  unmodified server used a private test port on localhost; no external chat was
  contacted. The temporary test folder's separate workspace-trust dialog had
  already been confirmed for our own fixture.
- A custom local marketplace plugin launched with normal `--channels` and
  initialized its real MCP server, but Claude displayed the approved-allowlist
  rejection. Its notification write succeeded; no ack appeared during the
  following **16.255 seconds**. The explicit policy rejection, not that timeout
  alone, identifies the cause.
- The same installed custom plugin with the development flag stopped at the
  development confirmation dialog. That follow-up dialog was recorded and left
  unaccepted before closing the owned pane.

The actual plugin tests loaded only local settings and overrode every inherited
user MCP server name with `/usr/bin/false` through session `--mcp-config`, so those
servers (including the operator seat) could not start. Built-in tools were empty;
only the probe reply/ack tool was allowed. This is probe isolation, not a proposed
production MCP profile. The earlier `--strict-mcp-config` control suppressed
plugin-owned servers: mirroring the official server under its scoped name gave a
clean banner and connected server but **no reply within 15 seconds**. Restoring
actual installed-plugin loading produced the successful round-trip. Never treat
a server-name imitation or banner as channel readiness.

The [official reference](https://code.claude.com/docs/en/channels-reference)
requires confirmation for development entries. The
[official channel policy](https://code.claude.com/docs/en/channels#enterprise-controls)
documents administrator-managed `allowedChannelPlugins` for exact plugin and
marketplace pairs, alongside `channelsEnabled`. No documented personal setting
for persistent named development-channel consent was found. We did not alter
managed policy or test Team/Enterprise policy enforcement on this Max account.
The seat launcher's settings contain plugin enablement and command permissions;
it still uses the development flag.

The [official changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
was checked for 2.1.x: 2.1.80 introduced channels, 2.1.84 added the managed
allowlist, 2.1.267 made unreadable allowlist policy fail closed, and 2.1.281 fixed
plugin-name matching in addition to marketplace matching. None of those entries
provides personal persistent development consent. These sources were checked on
2026-09-26; preview behavior may change.

ADR 0194 therefore specifies owner-visible `interactive` and `stream` selections:
interactive with a human available to confirm, stream for current unattended
Swarm dispatch. There is no automatic fallback. Owner-managed approval of the exact installed worker plugin is the preferred
unattended interactive path if the prepared probe passes. Stream stays default
until the owner opts in and the actual worker passes readiness, isolation and
lifecycle tests. See [the managed-consent plan](managed-consent.md), exact
[probe policy](managed-settings.probe.json), proposed
[worker policy](managed-settings.worker-proposed.json), and
[owner-run probe script](managed-channel-probe.py). No managed policy was applied. The plan also requires real wake/watch/Swarm
receipts from the development-channel operator seat after policy adoption and
at a coordinated fresh launch. It includes an explicit seat-preserving fallback
and the optional official-channel entries; these coexistence checks remain pending.
The script's syntax, local plugin install/cleanup, and refusal to launch without
policy were checked; the positive managed-policy round-trip remains pending James's
action. The [official deployment guide](https://code.claude.com/docs/en/managed-settings)
explicitly supports editing policy as the local administrator.

## Verification

This change adds probe evidence and a proposed design, plus corrects the plugin
README's universal marketplace-only claim; production launch code is unchanged.
Owned-file formatting and documentation-link checks pass. The full `pnpm check`
attempt stopped on 24 unrelated work-items formatting paths; [the captured output](full-check-blockers.txt) names every affected path. Those shared files were not edited
or reformatted for this change. No live service restart occurred.

## Mixed-build startup incident

[Investigation and corrected timeline](startup-incident.md): both live owners
remained schema 13 while the installed MCP required 14. The actual installed MCP
exited 1 against an isolated replay of that descriptor. Four closed-worker
transcripts show connection failures within 6–11 seconds of startup and zero
Swarm calls. The original exit reason was not retained; this does not prove
healthy MCP processes were killed by package replacement. ADR 0194 records the
readiness/claim gate, independent health reporting, progress alarms and upgrade
preflight. Dispatch remains held pending the coordinated restart.
