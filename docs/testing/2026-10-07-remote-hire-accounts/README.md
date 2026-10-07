# Remote hire accounts — 2026-10-07

[VUH-1527](https://linear.app/vuhlp/issue/VUH-1527) and
[VUH-1780](https://linear.app/vuhlp/issue/VUH-1780). Hires on a linked machine
now resolve `account` against that machine's own Claude profiles and Codex homes.
Not deployed; no live remote hire was started for this checkpoint.

## What the machine reports

`worker_accounts` / `clankie accounts workers --machine ID` /
`GET /v1/worker-accounts?fleet=ID` runs one Node script on the machine through
the fleet shell. It lists the default Claude profile and Codex home plus every
`~/.claude-<label>` and `~/.codex-<label>` (Codex needs `config.toml` or
`auth.json`), then asks each profile's own CLI: `claude auth status --json` and
Codex's app-server `account/read` plus `account/rateLimits/read`. Only label,
home, sign-in state, email, plan, usage windows and whether Clankie's worker
plugin is installed in each Claude profile leave the machine. No credential
file is opened. Windows children are ended with `taskkill /T`; no app-server was
left running after the live probe.

Live read of James's PC (`pc`, PowerShell over ssh), 4.0 s, identities redacted:

| Harness | Label   | Home                           | Signed in       | Plan | Headroom | Usable                        |
| ------- | ------- | ------------------------------ | --------------- | ---- | -------- | ----------------------------- |
| claude  | default | `C:\Users\volpe\.claude`       | no              | —    | —        | no: `claude auth login` on pc |
| claude  | james   | `C:\Users\volpe\.claude-james` | yes (account A) | max  | n/a      | yes                           |
| codex   | default | `C:\Users\volpe\.codex`        | yes (account B) | pro  | 100%     | yes                           |
| codex   | james   | `C:\Users\volpe\.codex-james`  | yes (account B) | pro  | 100%     | yes                           |

Both PC Codex homes reported the same ChatGPT identity; the live headroom does
not show a lapsed renewal, so the owner holds an account that should not be
picked automatically (`clankie accounts hold codex LABEL --machine pc`).

## Choice

An explicit label is used exactly or refused with the machine, profile, reason
and the command to run there; no other account is tried. Without one (or with
`auto`), a usable account the owner has not held is chosen, Codex by headroom,
and skipped accounts are named. A machine that cannot answer at all keeps its
default home for an automatic choice. The chosen non-default home reaches the
pane as `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, the remote Codex app-server and its
tracker read, and the remote Claude consent and tracker reads.

## Checks

- `apps/clankie/test/worker-accounts.integration.test.ts`: the real probe through
  a posix fleet shell against the installed `claude` and `codex` in a fixture
  home; API + CLI + hold/release through `createClankieApp`; hire refusals and
  pane environment through the remote Herdr runner, using the PC report above
  as a redacted golden.
- `apps/clankie/test/remote-codex-app-server.test.ts`: the chosen Codex home in
  the Windows server launch and tracker read; other per-hire environment still
  refused.
