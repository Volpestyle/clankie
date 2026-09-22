# Spider-Man through Rivals Agent

**The bridge stays disabled under [VUH-1325](https://linear.app/vuhlp/issue/VUH-1325).**
Independent review accepts the bridge sources with input path `a7f3445`; the
lift for reviewed practice-range paths does not authorize Clankie's bridge.
Clankie remains disconnected. No deployment, reconnection, task re-enabling or
sitting until the lead schedules it; `rivals-l4` owns the desktop. The lead must
verify the launcher's explicit cooldown argument before re-enabling. Every
sitting records the kit patch and cooldown regime. The commands below describe
the interface, not run authorization. Replay checks do not establish live input safety.

Clankie's `rivals` tool starts, observes, steers, shares, and stops a Spider-Man
practice-range sitting. Rivals Agent supplies the tactical policy and fast pad
loop. [ADR 0175](adr/0175-rivals-agent-is-a-gameplay-skill.md) describes the boundary.

## Set up the bridge

In the `rivals-agent` checkout, create a control token once:

```sh
uv run python -m agent.server --token-file data/clankie-token --init-token
```

The token file is private and gitignored. Store the same token in Clankie's
credential broker with `/auth rivals-agent`, or pipe the token to
`clankie rivals connect URL --token-stdin`. Do not put it in a URL or settings.

Run the server **inside the Windows interactive desktop**, with the existing
Rivals live dependencies installed, when that desktop is available:

```sh
python -m agent.server --host 127.0.0.1 --token-file data/clankie-token --cooldowns normal
```

Use an SSH forward from Clankie's Mac to that loopback port, or bind the server
to the PC's private network address and restrict its firewall to the Mac. Use
HTTPS on an untrusted network. The host option is deployment configuration, not
model input. Starting the server does not open the game or send input. The game
must already be focused in the practice range; coordinate ownership with any
other process driving the desktop before starting a sitting.

The server requires `--cooldowns off|normal`, without a default. The Windows
launcher requires the equivalent `-Cooldowns`. Match the verified game setting:
No Ability Cooldown ON means `off`; OFF means `normal`. This declares the regime;
it does not change the game. Each sitting records it and the patch read from the
Rivals kit in `game/meta.json` and `session.json`. An unreadable kit patch refuses
the start. The disabled PC deployment needs the reviewed files and an explicit
cooldown argument before an authorized restart.

```sh
clankie rivals connect http://127.0.0.1:4330
clankie rivals status
clankie rivals start autonomous
clankie rivals objective SESSION_ID combat Practice aiming
clankie rivals observe SESSION_ID
clankie rivals share SESSION_ID
clankie rivals share SESSION_ID GUILD_ID VOICE_CHANNEL_ID
clankie rivals stop SESSION_ID
```

`connect`/`disconnect` apply live. `/rivals` in the TUI accepts the same arguments.
`observe` returns PNG base64 in CLI JSON; the captain receives an actual image.
`share` returns a session-scoped, read-only watch URL. A browser must be able to
reach that URL's host (a loopback forward is local to the Mac). The optional
Discord destination uses the active user-session body's existing Go Live
publisher and its channel allowlist. An official bot body cannot publish Go Live.
Stopping the sitting invalidates the watch feed. Sharing currently carries video,
not game audio.

`starting` and `stopping` are pending states. Inspect `status` for `running`,
`stopped`, or `failed`. A supplied note is recorded, but the current policy only
acts on the three modes: `autonomous`, `combat`, and `disengage`. It reports
`noteApplied: false`; don't describe a prose instruction as learned or executed.
Session summaries and notes live under `data/clankie/<session>/session.json` in
Rivals Agent; its normal synchronized recording is under that session's `game/`.
Clankie can use his existing memory tools to retain useful experiences.

## Recorded-game verification

Run this on the Mac instead of the live server:

```sh
uv run --group perception python -m agent.server --token-file data/clankie-token \
  --dry data/l1/tagrun0 --cooldowns off
```

The same commands exercise real perception and controller logic against recorded
footage with a fake pad. Status explicitly says `execution: replay`. This proves
the integration without claiming that inputs changed the recorded game.
