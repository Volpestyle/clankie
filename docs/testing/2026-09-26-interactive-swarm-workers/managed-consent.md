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
contains that pair. **That worker plugin is not implemented or installed yet.**
Do not use the production snippet as evidence that this probe is allowed; the
identities intentionally differ. Repeat the readiness probe against the shipped
worker's actual code and identity before changing the runtime default.
The allowlist identifies a plugin and marketplace, not a pinned code version.

## Owner-run steps

Run from the Clankie checkout. The script never invokes sudo or writes policy.
It installs its reviewed fixture at local scope in a fresh private directory.

```sh
python3 docs/testing/2026-09-26-interactive-swarm-workers/managed-channel-probe.py prepare \
  --dir /tmp/clankie-managed-channel-probe
```

James reviews the snippet and fixture, then applies/merges the policy himself.
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

If both runs pass, owner-managed approval of the exact installed worker plugin is
the **preferred unattended interactive path**. The owner must then opt in through
Clankie's runtime mode setting once the actual worker integration passes its
readiness, capability, heartbeat and recovery tests. Until then, `stream` remains
the default. Failed or uncertain interactive startup stays visibly blocked;
there is no automatic fallback. Human-confirmed development mode remains useful
for local testing, not the intended unattended distribution mechanism.
