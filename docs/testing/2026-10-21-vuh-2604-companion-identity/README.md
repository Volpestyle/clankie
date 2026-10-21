# VUH-2604: the companion handoff goes only to a trusted app

Tracks: [VUH-2604](https://linear.app/vuhlp/issue/VUH-2604).
Decision: [ADR 0204 amendment, 2026-10-21](../../adr/0204-a-self-hosted-mac-pairs-the-app-directly.md).

## What bound the handoff before

The handoff was bound to the account, not the app:

- the private 0700 companion directory and 0600 files;
- the 0600 Unix issuer socket;
- a native loopback request without browser or forwarding headers.

Any same-user app that read `companion-offer.json` and posted to
`/v1/pairing/local/redeem` received the owner's "Clankie on this Mac" session.
Two isolated proof builds did exactly that (VUH-2587, VUH-2585).

## What binds it now

- **Identification:** the redeem names the process on the client end of its
  loopback socket (`lsof`), and `codesign --verify -R` checks that running code
  against the owner's trusted requirements, set with
  `clankie companion trust APP_PATH`.
- **Default and refusals:** the list starts empty, and an empty list refuses
  every app. A refusal is a 403 that consumes nothing and is recorded with the
  app's identity.
- **Installer:** it trusts the exact app it just verified, before handing off.

## Proof on this Mac (`apps/clankie/scripts/prove-companion-identity.ts`)

The runner starts a private scratch service (its own state, companion issuer and
relay). It builds three native Swift apps that speak the real redeem protocol:

| App                                             | Identifier                         | Code hash   |
| ----------------------------------------------- | ---------------------------------- | ----------- |
| Trusted                                         | `io.clankie.proof.vuh2604.trusted` | `4ff8cfac…` |
| Rogue                                           | `io.clankie.proof.vuh2604.rogue`   | `cc7276d6…` |
| Impostor (unoptimized rebuild, same identifier) | `io.clankie.proof.vuh2604.trusted` | `199057a4…` |

`proof-3` passed:

1. With nothing trusted, the rogue app is refused:
   `403 companion_app_untrusted` with reason `untrusted`.
2. `clankie companion trust TrustedCompanion.app` records
   `cdhash H"4ff8cfac…"`. Trusting it again adds nothing.
3. The rogue app and the impostor are refused again.
4. The trusted app redeems the **same** offer: 200, `device-8881d849-6e4`.
5. `events.jsonl` has three `pairing.local_companion.refused` events, naming the
   rogue app twice and then the impostor (by pid, identifier, code hash and
   path). `device.activated` names the trusted app, its code hash and the
   trusted entry's id.
6. A Developer ID-shaped requirement (`anchor apple generic`, identifier and team
   `ABCDE12345`) refuses the ad-hoc trusted build that claims the bundle id.

`proof-1` failed on a runner bug (it read `CDHash` at too low a verbosity).
`proof-2` passed but left a detached relay that `pair` had started; the runner
now starts and stops its own relay.

## Not done here

- **James's app is untouched.** The installed `/Applications/Clankie.app`
  (ad-hoc, `org.reactjs.native.ClankieMacOS`) and its pairing were not run or
  changed. Its existing session keeps refreshing, but its next handoff (after a
  reinstall or lost session) is refused until the owner runs
  `clankie companion trust /Applications/Clankie.app`.
- **No Developer ID check.** No Developer ID-signed release exists yet
  (VUH-1727). The team-bound path was proven only as a refusal of an ad-hoc
  build.
- **Rest of the account boundary.** Code already running as the owner can still
  read the owner's files and settings. This binds the automatic handoff, not the
  account.

## Final result

The [raw `proof-3` bundle](clankie://evidence/sha256/7c83c50a42c6edfe5dbfb81a6d19314755b35dbfdaa47f2b6a9c8c4307066758)
holds `result.json`, the service, relay and runner logs, the service's
`events.jsonl` and the companion source. Scratch credentials and the handoff
file are excluded.
