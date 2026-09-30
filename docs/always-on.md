# Keeping Clankie reachable when the Mac sleeps

A Mac that sleeps is asleep to everything on it: Clankie's service, his Discord
bodies and the connection the app reaches him through all stop until it wakes.
Clankie treats that as a normal condition to recover from, not a fault
([ADR 0203](adr/0203-clankie-keeps-what-better-models-cannot-absorb.md)).
"Always on" is the owner's choice between three ways to live with it.

| Choice            | What it means                                                                  | Use it when                                                    |
| ----------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Let the Mac sleep | The default. Clankie recovers on wake (below). Nothing to set up.              | The Mac is a laptop you carry, or you can wait for it to wake. |
| An awake Mac      | `clankie awake on`: the launcher holds the Mac awake while it is plugged in.   | The Mac is your always-plugged-in home machine.                |
| A hosted Clankie  | His body runs on Clankie's service, not your Mac. The Mac can sleep or be off. | You want him reachable without keeping a computer running.     |

## What recovers on its own

Sleep costs time, not messages or the sign-in. After a wake:

- Discord catches up on messages that arrived while the gateway was down
  ([VUH-1447](testing/2026-09-29-discord-reconnect-recovery.md)).
- The account doorway reconnects without a new sign-in, including after a lost
  token rotation ([VUH-1451](testing/2026-09-30-gateway-refresh/README.md)).
- The app reconnects through the doorway once the service does.

Those are tested with fakes. A real sleep and wake is a human check:
[the wake test](testing/2026-09-30-host-sleep-awake/README.md).

## Telling when this Mac may sleep

`clankie doctor` reports `power` and, when the Mac can sleep, a remediation naming
the fix. The service reports the same object on `/health` (`power`), so the app
can say why he went quiet. It answers three questions:

- **`state`**: `always_on`, `sleep_allowed` or `unknown`. `sleep_allowed` means
  the Mac will idle-sleep on its current power source and nothing is holding it
  awake. `unknown` (no `pmset`, as on a hosted body) raises no warning.
- **`source` and `sleepAfterMinutes`**: plugged in or on battery, and the
  `pmset` idle sleep for that source (`0` is never). A laptop is often set to
  never sleep on AC and sleep after a minute on battery: on battery it is
  `sleep_allowed`.
- **`lastSleep`**: when the running service last noticed the host sleep
  underneath it. The service cannot see itself asleep, so this is inferred from a
  timer that fired far too late. It also catches DarkWake, where the Mac wakes for
  seconds and goes straight back down. It is in memory: a service restart clears
  it.

A Mac cannot report that it is asleep while it is asleep. From the app, "asleep"
is the doorway being unreachable; `power` is what the host last said before it
went, and `lastSleep` is what it says on waking.

## An awake Mac

```sh
clankie awake on      # store the opt-in and start the keep-awake now
clankie awake status  # the opt-in, the launcher's process, and the power state
clankie awake off
```

The console has the same command as `/awake`. `on` stores `host.keepAwake` and the
launcher supervises `caffeinate -s` like any other service (`clankie status` lists
it as `awake`). Three properties are deliberate:

- **Plugged in only.** macOS holds a `-s` assertion only on AC power. Unplug and
  the Mac sleeps as its own settings say; nothing here watches the charger, and
  `doctor` says "on battery" so the owner knows.
- **It changes no power setting.** It never writes `pmset`. Turn it off and the
  Mac is exactly as it was.
- **Opt-in, and it survives restarts.** The launcher restarts `awake` with the
  clankie service, so [`clankie autostart enable`](cli.md#service-lifecycle)
  brings it back at login. Without autostart, a rebooted Mac stays down until you
  log in and run `clankie`.

A `caffeinate -s` you started yourself is left alone and is never mistaken for
the launcher's. Amphetamine and other tools that hold a sleep assertion count in
`heldAwakeBy`.

Limits, stated plainly: this holds against idle sleep on AC power. Closing a
laptop lid follows macOS's own clamshell rules and is part of the wake test, not
something this guide promises. It does not survive a power cut, a restart, or
the Mac being unplugged. If the Mac must be reachable regardless, use a hosted
Clankie.

## A hosted Clankie

A hosted body runs on Clankie's service rather than your Mac, so your Mac's power
does not matter to it. It sleeps when idle and the app or a Discord mention wakes
it ("Asleep" and "Waking" in the app are that, not a fault). Sign in with
`clankie login`, or `clankie connect hosted` to require one, then pair the app;
see [local and hosted connection modes](cli.md#local-and-hosted-connection-modes).
Setup and pricing are in the [public field guide](https://docs.clankie.bot/get-started/).
Self-hosting the same body on your own Linux host is in
[Linux self-hosting](../infra/hosted/README.md).

`awake` is local only: it refuses in hosted mode and on non-macOS hosts, and a
hosted loadout never runs it.

## Why `caffeinate -s`

`caffeinate` is the native, dependency-free way to hold a sleep assertion, and `-s`
is the one macOS documents as valid on AC power only, which is what "keep it awake
while plugged in" means. `-i` also holds on battery, which would drain a laptop in a
bag, so it is not used. Doing this through the launcher instead of the owner's own
`caffeinate` gives it the same supervision, status and stop path as every other
service.
