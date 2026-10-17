# VUH-1622: Discord roles and tracking, fixture proof

[Issue](https://linear.app/vuhlp/issue/VUH-1622) ·
[role model](../../adr/0227-discord-connects-a-server-with-a-role.md)

This is a verification slice of the existing implementation. The new tracking
matrix was written first and passed against unchanged product code on core
`a63981579`. No product change was needed. App `9b65a6a6` and ops `0740b00`
were inspected, not modified. The earlier [core proof](../2026-10-05-discord-server-role/README.md)
and [app proof](https://github.com/Volpestyle/clankie-app/tree/19933744/docs/testing/2026-10-05-discord-server-settings)
describe the original implementation and native captures.

## What this proves

The tracking tests cross real temporary settings/tracker files, signed webhook
HTTP, verified tracker/account reads, the shared native body admission and a
recording loopback Discord REST server. No Discord login or external server is
used. The unrelated captain/model lane is stubbed. The REST wire fixture is not
evidence of Discord's production permissions or successful invitation acceptance.

For both a text-channel mirror and a forum mirror, the matrix sends ten event
categories at each of the four owner-selected levels: **80 cases** total.

| Event                           | Off | Project updates | Project activity | Every issue |
| ------------------------------- | --- | --------------- | ---------------- | ----------- |
| Published project update        | No  | Yes             | Yes              | Yes         |
| Project status change           | No  | No              | Yes              | Yes         |
| Project milestone               | No  | No              | Yes              | Yes         |
| New issue                       | No  | No              | Yes              | Yes         |
| Issue status change             | No  | No              | Yes              | Yes         |
| Finished issue                  | No  | No              | Yes              | Yes         |
| Issue comment                   | No  | No              | No               | Yes         |
| Issue title edit                | No  | No              | No               | Yes         |
| Project rename                  | No  | No              | No               | No          |
| Update for an untracked project | No  | No              | No               | No          |

Each admitted case produces exactly one content-bearing delivery; each excluded
case produces no native mutation. Every event is sent again after reopening the
durable tracking journal: **zero duplicate mutations**. Each representation
creates one project destination and retains one issue destination. New project
channels/forums deny View Channel to `@everyone`, allow the verified bot member
and configured owner, and suppress mentions. Fleet display is off throughout,
so its switch cannot accidentally gate project tracking.

The accompanying existing integration tests also pass: role-correct invitations,
missing/restored Administrator, gateway permission overwrite precedence,
unavailable evidence remaining unchecked, explicit authenticated test posts,
lost receipts without replay, Admin create/place/archive/member/role/webhook
actions, deletion/ownership-transfer refusals, participant projections and
permission-boundary rechecks. All their effects terminate at local fixtures.

## Checks and records

The focused four-file run passed **29 tests**. The final tracking capture run
passed **6 tests**, including both new matrix journeys. Run all commands through
the fleet governor:

```sh
SETUP_PERMISSIONS_EVIDENCE_DIR="$PWD/docs/testing/2026-10-17-discord-role-fixtures" \
  clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/discord-tracking.integration.test.ts \
  apps/clankie/test/discord-server-role.integration.test.ts \
  apps/clankie/test/discord-setup-permissions.integration.test.ts \
  apps/tui/test/discord-setup-integration.test.ts
```

`evidence.json` points to the retained matrix events, native mutations, journal,
permission/setup/TUI records and JUnit reports. Only this README and the evidence
index are committed. Final landing-gate results and revision are posted on the
issue after the gate completes; the focused run is not a substitute for it.

## Remaining owner/ops proof

The October 15 issue closeout still requires the ops dashboard bridge rollout
and real Oathkeeper/Blinkercity captures. The latest recorded Oathkeeper setup
check lacked Administrator. James owns any invitation or bot permission change.
The outstanding live journeys are Admin create → admit the right members →
archive, all four tracking levels and private-channel visibility, and participant
behavior under real channel permissions. VUH-1831's later ownership model remains
in force: a server's Admin role does not grant its members machine authority.

No live server, invite, bot/application configuration, credential, account,
production message, deployment, eval or physical-device installation was touched.
No simulator or long-lived server was acquired for this test-only change.
