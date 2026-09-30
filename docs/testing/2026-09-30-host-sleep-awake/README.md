# Host sleep and the awake Mac — VUH-1461

Clankie now says when this Mac may sleep, and offers an always-on option. The
code is proven with fakes. **Real sleep/wake recovery is not proven yet: it is a
human check, and the steps are below.** No power setting was changed, no `caffeinate`
was started, and the Mac was never put to sleep while building this.

## Evidence (fakes)

- [Protocol](evidence/protocol-tests.log): 14 tests. `pmset` parsing on the real
  output shapes (`-g batt`, `-g custom` where `displaysleep` and `disksleep`
  must not read as `sleep`, `-g assertions`); a `PreventSystemSleep` assertion
  counts only on AC; the verdict and its advice for battery, AC, keep-awake
  requested but not held, and no signal.
- [Service](evidence/service-tests.log): 6 tests. A timer firing 14 minutes late
  is recorded as a sleep and reported once awake; an ordinary tick and a 20 s
  stall are not; the keep-awake opt-in is read fresh, so `awake on` needs no
  restart; `/health` carries `power` and omits it when no monitor is wired.
- [Console and launcher](evidence/tui-tests.log): 121 tests across the touched
  files. `doctor` names a Mac on battery with sleep allowed, `clankie awake on`
  and the hosted alternative; it stays silent with no `pmset`; the service's
  `lastSleep` arrives through the one existing `/health` probe. `awake on`
  spawns exactly `caffeinate -s`, stores the opt-in, and only ever asks `pmset`
  with `-g`; `off` stops the process it started; a `caffeinate -s` the owner
  started is neither conflicted with nor mistaken for the launcher's.

## What the fakes cannot show

- That a real Mac wakes and every part recovers together.
- That `caffeinate -s` keeps a **lid-closed** MacBook awake on AC. The `caffeinate`
  manual documents `-s` as an AC-only system-sleep assertion; clamshell behavior
  is macOS's own and untested here.
- The app-side display. This repo ships the signal (`power` on `/health`, the
  `@clankie/protocol/host-power` contract); rendering it in the app is in
  `clankie-app`, not done here.
- `lastSleep` after a service restart: it is in memory.

## The wake test (for James)

Before you start: Amphetamine and a `caffeinate` were holding this Mac awake when
this was written (`pmset -g assertions`). Quit them, or every step below reads
"awake" for the wrong reason. Have the app paired and a second device that can
send to Clankie in Discord.

### A. The default: sleep, then recover

1. Confirm the baseline: `clankie doctor | jq .power`. On battery you should see
   `"state": "sleep_allowed"` with `advice`. Note `clankie status` is `ready`.
2. Make sure `clankie awake status` says `"keepAwake": false`.
3. Note the time, then `pmset sleepnow` (or close the lid on battery).
4. From the second device, wait two minutes, then send a Discord message that
   addresses Clankie (a mention or DM). Also send one more a minute later.
5. Leave the Mac asleep at least 10 minutes. For the sign-in check, one run of an
   hour or more, so the account access token has expired at wake (I did not check
   its configured lifetime).
6. Wake it (key press or open the lid). Do nothing else. Within about a minute:
   - `clankie status` returns `ready`, `clankie gateway status` shows the doorway
     `connected` with **no** sign-in prompt (VUH-1451).
   - Clankie replies to both messages sent while it slept (VUH-1447).
   - The app opens and loads its conversation without re-pairing.
   - `curl -s 127.0.0.1:4310/health | jq .power.lastSleep` shows `sleptAt`,
     `wokeAt` and `seconds` close to the time it slept, and
     `clankie doctor | jq .power.lastSleep` matches.
   - The service log has a `host.slept` event.
7. Failure to record: which of the three did not recover, and the
   `clankie gateway status` and doorway log lines at wake.

### B. The awake Mac

1. Plug in. `clankie awake on`. Expect `"keepAwake": true`, `service.state`
   `healthy`, and `pmset -g assertions | grep -B1 -A1 caffeinate` showing
   `PreventSystemSleep` for a `caffeinate` you did not start by hand.
2. `clankie doctor | jq .power`: `state` `always_on`, `heldAwakeBy` includes
   `caffeinate`, no advice. `clankie status` lists `awake` as healthy.
3. Lid open, idle past your battery sleep time is not informative if AC sleep is
   already "never". The informative checks are the next two.
4. **Lid closed on AC** (no external display) for 5 minutes. Send a Discord
   message from the second device. Record whether the Mac stayed awake and Clankie
   answered. This is the claim the fakes cannot make; either result is useful.
5. **Unplug**. `clankie doctor | jq .power` should now say
   `sleep_allowed`, `source` `battery`, and the advice should mention that
   keep-awake only holds while plugged in. Leave it idle: the Mac should sleep
   on your battery timer even though `caffeinate` is still running.
6. `clankie awake off`. `pgrep -x caffeinate` shows no launcher-started process,
   and `pmset -g custom` is unchanged from before step 1.
7. Reboot with `clankie autostart enable` set and `awake on`: after login,
   `clankie awake status` is healthy without running anything by hand.

Attach the outputs of the commands above, and the failure record if any step
failed, to VUH-1461.
