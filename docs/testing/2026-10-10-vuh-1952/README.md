# VUH-1952: Codex hires use Clankie's Linear

Tracks: https://linear.app/vuhlp/issue/VUH-1952

Base: fetched `origin/main` at `2c811fdb65a44b55c79c285a35de136317d7c38e`.
The bug remains there: inherited Linear MCP servers are disabled, but Codex's
Linear app connector is not included in `codex mcp list` and remains available.

## Discovered IDs, rather than an install-specific assumption

The installed curated Linear manifest names
`asdk_app_69a089a326dc8191b32a3f2553f5be2c`, but that inspection alone does not
prove every owner or historical connector uses that ID. The final implementation
does not hardcode it. Local and remote preparation read the selected account's
native `app/installed` snapshot, find Linear by runtime name, and add
`apps.<returned-id>.enabled=false`. Other apps and owner config files are untouched.
An unreadable/malformed catalog or unsupported Linear ID refuses the launch.
There is no thread creation or model turn in discovery.

The API and per-app flag are documented in the official
[app-server reference](https://learn.chatgpt.com/docs/app-server) and
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Native proof on this Mac

Executed the production discovery program against the installed signed-in
`codex-cli 0.162.1`, then repeated the native read with its returned overrides.

| Observation | Before | With discovered override |
| --- | --- | --- |
| Linear installed app ID | `asdk_app_69a089a326dc8191b32a3f2553f5be2c` | Same returned ID |
| Linear effective `enabled` | `true` | `false` |
| Other installed apps | 14 enabled | All 14 unchanged |
| Installed app count | 15 | 15 |

Native `config/read` also confirmed that the discovered ID's effective
`enabled` value is `false`. Raw local captures: `.local/vuh-1952/native-proof.json`
and `.local/vuh-1952/native-metadata.txt`. No PC Herdr or shell was touched.

The native run changed the implementation: the full-directory `app/list` read
timed out while paging and emitted ~6.9 MB notifications; installed runtime
metadata avoids that pagination. A quoted-ID override left Linear enabled;
the final bare-key override passed. Discovery retains a 30-second deadline and
a 16 MiB framing bound for the observed native initialization notifications.

## Focused checks

`clankie heavy -- pnpm exec vitest run apps/clankie/test/tracker-isolation.test.ts apps/clankie/test/remote-codex-app-server.test.ts`

Final run: **2 files, 31 tests passed, exit 0**, at 20:58:59 America/Chicago,
duration 1.90s. Checks cover different returned local and remote IDs, isolation
from non-Linear apps, selected remote account home, invalid catalog/ID refusal,
and existing inherited MCP-server isolation. The earlier remote fixture returned
the MCP listing for the new app read; that fixture was corrected before this run.

Scope: native Mac configuration/catalog proof plus remote launch boundary
fixtures. Existing running hires retain their original launch configuration;
the new isolation takes effect on fresh launches after deployment.

## Live connected-account write

This existing Codex hire posted the
[issue evidence comment](https://linear.app/vuhlp/issue/VUH-1952#comment-f393ebe2-5c89-40cf-9234-abf28c9e1af6)
through `clankie_call(linear_save_comment)` without a native approval prompt.
Immediately beforehand, `linear_get_user(me)` confirmed Clankie's workspace
OAuth app (`9f8a15ed-d7cd-4e7e-bbb8-aba8696dd185`).
The applied comment receipt is `4fc309dd-7008-4f6a-be87-5df91d63540b`.
This proves the connected write route, separately from the native launch-config
proof above; it does not claim the existing hire adopted new launch flags.
