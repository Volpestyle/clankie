# Owner-managed channel consent: prepared, not applied

This is the next VUH-1380 experiment. **No managed policy was written and no
managed-policy channel success is claimed.** The probe uses the same exact
custom plugin/marketplace pair that failed the default allowlist test. Its server
only acknowledges local test events; it carries no operator or worker credential.

## Documented path and schema

The [official deployment guide](https://code.claude.com/docs/en/managed-settings)
places macOS policy at
`/Library/Application Support/ClaudeCode/managed-settings.json`, using the same
JSON shape as settings. It explicitly permits a local administrator to edit that
source. James can therefore grant persistent consent as this Mac's administrator;
this is a supported policy mechanism, not a development-flag bypass.

The [settings reference](https://code.claude.com/docs/en/settings-reference#allowedchannelplugins)
defines `allowedChannelPlugins` as a managed array of objects with `marketplace`
and `plugin` strings. The [channel guide](https://code.claude.com/docs/en/channels#restrict-which-channel-plugins-can-run)
explicitly supports internal marketplaces. Version 2.1.84 introduced the setting;
2.1.281 fixed matching the installed plugin name as well as its marketplace.
Installed 2.1.283 is later than both. These sources establish version support for
the policy and exact pair; a successful custom-plugin round-trip under the
personal Max account remains **unmeasured**. The account-specific policy wording
in the channel guide is a reason to run this probe, not to assume success or
reject the supported local-admin path.

The read-only preflight found neither the main managed file nor its adjacent
`managed-settings.d` directory on this Mac. Recheck before applying anything.
MDM or remote managed policy can outrank the file; `/status` must identify the
effective source. This policy affects Claude Code across the machine and replaces
the default channel allowlist. Preserve any other owner-approved entries and
unrelated settings; do not overwrite an existing policy with this minimal snippet.

## Exact probe policy

[managed-settings.probe.json](managed-settings.probe.json):

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [{ "marketplace": "swarm-channel-consent-probe", "plugin": "swarm-probe" }]
}
```

This approves only the installed probe pair. It does not enable a bare server,
grant shell permissions, install a plugin, or select interactive Swarm mode.

For the future worker package, the proposed exact identity is
`clankie-worker@clankie`, separate from the operator-seat `clankie@clankie`.
[managed-settings.worker-proposed.json](managed-settings.worker-proposed.json)
contains that pair plus `clankie@clankie` to preserve the operator seat explicitly. **That worker plugin is not implemented or installed yet.**
Do not use the production snippet as evidence that this probe is allowed; the
identities intentionally differ. Repeat the readiness probe against the shipped
worker's actual code and identity before changing the runtime default.
The allowlist identifies a plugin and marketplace, not a pinned code version.

## Preserve the operator seat and other channels

The [official channel policy](https://code.claude.com/docs/en/channels#restrict-which-channel-plugins-can-run)
says the development flag can bypass even an empty plugin allowlist when channels
are enabled. That predicts the existing seat will keep receiving events with
`--dangerously-load-development-channels plugin:clankie@clankie`, but **we have
not measured that under managed policy**. The seat coexistence test below is
required before retaining the policy or enabling unattended workers.

If the seat stops receiving events, the owner must restore the previous policy
first, then explicitly add this entry for the next coordinated trial:

```json
{ "marketplace": "clankie", "plugin": "clankie" }
```

[managed-settings.probe-with-seat.json](managed-settings.probe-with-seat.json)
contains the complete probe-plus-seat policy. Retain any other owner-approved
entries when merging it. Adding the seat is required if omission breaks delivery,
but is not itself proof of recovery: repeat the event checks and restore the
prior policy if they still fail. Keep the seat's existing development launch flag
for this compatibility test; do not switch its transport or copy its bearer into
the worker fixture. The proposed production policy includes the seat explicitly
regardless of the bypass result.

The read-only `claude plugin list --json` inventory on 2026-09-26 found none of
these official channel plugins installed. The fakechat state directory remains
from the earlier test, but its plugin was uninstalled; a directory is not an
active channel. No credentials were read. Recheck the inventory with James before
applying policy, including channel use from other projects or sessions.

| Preserve if James uses it        | Exact additional allowlist entry                                     |
| -------------------------------- | -------------------------------------------------------------------- |
| Telegram                         | `{ "marketplace": "claude-plugins-official", "plugin": "telegram" }` |
| Discord                          | `{ "marketplace": "claude-plugins-official", "plugin": "discord" }`  |
| iMessage                         | `{ "marketplace": "claude-plugins-official", "plugin": "imessage" }` |
| Local fakechat demo, if retained | `{ "marketplace": "claude-plugins-official", "plugin": "fakechat" }` |

These are the official channels documented at the time of the check, not an
exhaustive frozen default allowlist. Preserve any other channel James identifies.
The installed Expo, Figma and Swift LSP plugins are not these chat channels; they
do not need entries merely to retain their ordinary tools. Clankie's own Discord
body is also separate from the official Claude Code Discord channel plugin.

## Owner-run steps

Run from the Clankie checkout. The script never invokes sudo or writes policy.
It installs its reviewed fixture at local scope in a fresh private directory.

```sh
python3 docs/testing/2026-09-26-interactive-swarm-workers/managed-channel-probe.py prepare \
  --dir /tmp/clankie-managed-channel-probe
```

Before applying policy, the seat lead records a baseline from the actual
`clankie@clankie` development-channel seat: one harmless Clankie wake, one
`herdr_watch` settlement from an owned probe, and one Swarm envelope. Give each
an identifiable nonce, retain its source event/message ID and emission/receipt
timestamps, and observe the seat consume it through the channel. Arrange these
through the existing service/Swarm producers, not pasted terminal prompts. A
Herdr prompt response alone does not establish channel delivery. The lead owns
this check and keeps a terminal available independently of the seat channel for
recovery. Do not restart the live seat or service just to prepare this experiment.

James reviews the snippet, preserve list and fixture, then applies/merges the
policy himself.
**Only if the policy file is still absent**, these are the exact owner commands;
they are supplied for review and have not been run:

```sh
sudo install -d -m 0755 '/Library/Application Support/ClaudeCode'
sudo install -m 0644 \
  docs/testing/2026-09-26-interactive-swarm-workers/managed-settings.probe.json \
  '/Library/Application Support/ClaudeCode/managed-settings.json'
```

If policy already exists, back it up and merge the exact entry instead. Keep its
original contents for restoration. Coordinate this machine-wide change with the
fleet lead; file policy can reload in existing sessions.

After application, the seat lead verifies the effective managed source under
`/status` and repeats all three baseline events while the seat is idle. Record
the active policy's exact allowlist, the unchanged development launch flag, and
actual channel receipts. Check again after the two worker-probe launches below.
Policy observation/reload must be established first; success in a session that
has not loaded the new policy is not a pass. Include a fresh seat launch and
repeat the same events at a restart window the lead coordinates; a hot-reload
result alone does not establish future startup compatibility. Human confirmation
of the seat's existing development dialog is allowed; it does not satisfy the
worker's unattended-consent criterion.

If any seat event fails or policy adoption is uncertain, stop the trial and have
James restore the prior policy; do not leave a disconnected lead to recover via
the same channel. Test the explicit probe-plus-seat policy only in a coordinated
second window, then repeat both seat and worker checks. Do not declare success
until the final policy passes all checks. Save the baseline and policy-enabled
seat receipts alongside the worker evidence; this coexistence evidence is still
pending, not implied by the official docs.

In an owned interactive terminal, start the fixture:

```sh
python3 docs/testing/2026-09-26-interactive-swarm-workers/managed-channel-probe.py launch \
  --dir /tmp/clankie-managed-channel-probe
```

Confirm workspace trust for the reviewed temporary folder if asked. The launch
uses normal `--channels plugin:swarm-probe@swarm-channel-consent-probe`, **never**
the development flag. It loads local settings only and replaces inherited user
MCP commands with `/usr/bin/false` for this session. It keeps real plugin loading,
allows only the ack tool, and strips Clankie bearer and Swarm capability variables.

Check `/status`: the settings source should include
`Enterprise managed settings (file)`. Record the effective source and any warning;
do not accept a channel development dialog or switch flags to make the test pass.
Exit the status panel and leave Claude idle. In a second terminal:

```sh
python3 docs/testing/2026-09-26-interactive-swarm-workers/managed-channel-probe.py emit \
  --dir /tmp/clankie-managed-channel-probe
```

A pass requires a real ack within 20 seconds, no channel consent dialog, and no
allowlist rejection. The script records `roundtrips.jsonl` and `events.jsonl` in
the private fixture directory. Save a sanitized startup/status transcript too.
Quit the owned Claude session and repeat **launch**, `/status`, and **emit** with
a fresh session. Both runs must pass without renewed channel consent; this tests
persistence rather than a single session's approval. No task may be marked ready
from MCP initialization, idle state, or the banner alone.

After closing the owned session:

```sh
python3 docs/testing/2026-09-26-interactive-swarm-workers/managed-channel-probe.py cleanup \
  --dir /tmp/clankie-managed-channel-probe
```

Cleanup removes only the fixture's local plugin and marketplace declaration; it
does not edit policy or delete evidence. James restores the prior managed file,
or removes the file if this experiment created it, after coordinating with the
lead. Do not delete the policy directory or any unrelated policy entries.

## Decision after the probe

If both worker runs and the seat coexistence checks pass, owner-managed approval of the exact installed worker plugin is
the **preferred unattended interactive path**. The owner must then opt in through
Clankie's runtime mode setting once the actual worker integration passes its
readiness, capability, heartbeat and recovery tests. Until then, `stream` remains
the default. Failed or uncertain interactive startup stays visibly blocked;
there is no automatic fallback. Human-confirmed development mode remains useful
for local testing, not the intended unattended distribution mechanism.
