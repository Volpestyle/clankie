# Companion pairing on a fresh Mac install — VUH-1728

Tracks: [VUH-1728](https://linear.app/vuhlp/issue/VUH-1728). Fix
[`bf4dc4226`](https://github.com/Volpestyle/clankie/commit/bf4dc4226e803fdf2877c248f617771d9a9b95bc),
based on `origin/main` at `73c7f0fca`. Service contract:
[local companion](../../local-companion.md); installer contract:
[distribution](../../distribution.md#mac-companion-app).

## Outcome

- A fresh Mac install could not pair without an owner step. `install.sh` started
  the service only on Linux, so the launch step's `clankie pair --local-companion`
  refused as `unauthorized` and `launchMacApp` never opened Clankie.app. The
  installer now runs `clankie start clankie` before the launch step when it
  installs the app. `--no-app` and Linux installs are unchanged.
- The real service entrypoint pairs the app through its private issuer. Rerunning
  the installer, or re-requesting after the app's Keychain session is lost, keeps
  one device with its grants.
- Not proven: a signed Clankie.app's first launch and reinstall on a clean Mac.
  That waits on VUH-1727 (signing) and VUH-1730 (the pin is still `app: null`).
  `clankie start clankie` was not run from `install.sh` against a scratch stack.
  The fixture test covers its ordering, and Linux releases already use it.

## Gap reproduced

This used a fresh scratch state root from `node scripts/scratch-stack.mjs DIR
--broker-operator`, with no operator token and no running service, then ran the
installer's own launch step:

```
$ node scripts/scratch-stack.mjs run DIR cli pair --local-companion --json
{"ok":false,"status":"unauthorized","error":"Operator credential unavailable. Start the clankie service once, then retry."}
```

[`mac-app.integration.test.ts`](../../../apps/tui/test/mac-app.integration.test.ts)
runs the real `install.sh` (on darwin-arm64). It now checks that `start clankie`
comes before `pair --local-companion`, and that `--no-app` adds neither. On
unchanged main it fails with `expected -1 to be greater than or equal to 0`. With
the fix it passes 3/3.

## Real-service proof

The same state root, after the actual `apps/clankie` entrypoint started on scratch
ports (`clankie heavy --server -- node scripts/scratch-stack.mjs run DIR clankie`).
The client calls mirror clankie-app's `ClankieCompanionHandoff.swift`: a
private-socket handoff with no bearer, then a loopback redeem.

| Check                                                  | Result                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| Issuer published with private modes                    | dir `700`, descriptor `600`, socket `600`                        |
| App handoff over the Unix socket, no bearer            | 200 `{ready:true}`, handoff file `600`, loopback origin          |
| First redemption                                       | 200, one device, Take Control grants, loopback control and relay |
| Replay of a consumed offer                             | 409                                                              |
| Device token restores over loopback                    | 200                                                              |
| Installer step `clankie pair --local-companion --json` | `{ok, localCompanion, handoffPath}`; no secret in stdout         |
| Installer-rerun redemption                             | same device ID                                                   |
| App re-request (lost Keychain session)                 | same device ID and grants                                        |
| `clankie devices --json`                               | exactly one active "Clankie on this Mac"                         |
| Browser `Origin`, `X-Forwarded-For`                    | 403, offer not consumed                                          |
| Offer mint without bearer over TCP                     | 401                                                              |
| `/v1/pairing/local/handoff` over TCP                   | 404                                                              |
| Event log                                              | no offer secret or device token                                  |

There were two runs against one service, with ten redemptions mixing app and
installer handoffs: 17/17 passed. Run 1's single failure was a URL comparison bug
in the proof script. Every redemption reused one device.

## Checks

- `clankie heavy -- pnpm check:landing`: exit 0 on `bf4dc4226`. Format, lint, docs
  and typechecks passed, and the affected tests passed 3/3.
- An independent native review found nothing blocking. It raised two low notes,
  both predating this change. First, a rerun while an older release's service is
  healthy pairs against that service. Second, the fallback message is generic
  when `start` is refused, for example on a joined machine.
