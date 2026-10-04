---
name: pokeagents
description: Start or recover a local PokeAgents world for Clankie, join FireRed or Emerald, and follow his play or watch surface. Use for Pokémon play requests and world_unreachable refusals.
---

# PokeAgents with Clankie

Clankie's `pokeagent_*` tools use his own provisioned seat. The separate
`pokeagents` program runs the world; joining does not start that server.
An owner request to start the local world and play includes running its host
through the machine tools available in that turn, including trusted Discord
voice handoffs. Keep the existing room authority boundary.

## Get the world running

Use `command -v pokeagents` to find the installed host command. Its source
checkout provides the same CLI as
`pnpm --filter @pokeagent-mmo/world-server admin <command>` from that checkout.
The host is a separate installation, not bundled with Clankie. If neither is
available, identify that missing prerequisite rather than inventing a server.

Match the endpoint Clankie's service uses: `WORLD_ADDRESS` when configured,
otherwise `WORLD_STATE_DIR` (default `~/.pokeagent-mmo/world`) and its
`host.sock`. A shell's environment need not match a running service. A remote
world cannot be recovered by starting a different local world.

For the local installation:

1. Run `pokeagents check` with the matching endpoint. This checks reachability
   without taking a seat. **Omit the subject**: `check <subject>` joins as that
   player and can replace their active sitting.
2. If the local host is down, run `pokeagents start` in a persistent terminal
   or process session using the installed runtime. This is a foreground server;
   keep that session alive. With Herdr, use its terminal commands (the `herdr`
   skill has the syntax). Reuse a healthy world; do not stop another player's
   server or start competing copies.
3. Wait for `pokeagents check` to answer, inspecting startup output if it does
   not, then retry `pokeagent_join_mmo`. A failed start calls for diagnosing its
   concrete error, not repeatedly retrying joins.

The default host reads operator-owned cartridges from
`~/.pokeagent-mmo/roms/firered.gba` and `emerald.gba`. Without cartridges it can
run synthetic gameplay; do not describe that as the real game. Use the host's
README for nondefault ROM, state, watch, or network configuration.

`no_credential` is a separate provisioning problem. Use Clankie's existing
broker-backed seat; do not read holder secrets into context, borrow another
player's identity, or mint a replacement just to recover a stopped server.
`pokeagents holders` lists subjects and grants without secrets if needed.

## Play and watch

Call `pokeagent_join_mmo` with `pokemon-firered` or `pokemon-emerald`. It starts
Clankie's own play driver as part of joining: do not launch a second generic
MCP/CLI player or a second button-pressing agent. `joined` confirms the sitting;
`pending` needs a later status check; `join_refused` needs its named cause
handled. For `play_session_active`, inspect the existing run instead of joining
again.

Pokémon and Minecraft share the `play` lease; inspect the current holder before
trying to join a second game. Play belongs to the conversation that started it. A typed `bodyLease` busy
result names the thread holding the controls; queue or ask that thread instead
of taking over. A stop request, timeout, or failed lifecycle report does not
prove departure. Recovery waits for the actual driver to settle and an exact
world-session leave receipt. Lost authentication or a lost join receipt retains
uncertainty; do not start a replacement sitting to work around it. Operator
HTTP intents must select an existing writable `conversationId`; the host
authenticates the operator separately from those request fields.

Use `pokeagent_world` to discover the current session's granted operations and
check its status, `pokeagent_observe` to see the game, and `pokeagent_recall` for
the play history. The driver chooses its own actions while you keep talking to
the room. `pokeagent_stop` ends Clankie's sitting; it does not require stopping
the shared world.

The local host's default viewer is `http://127.0.0.1:7780/gallery`. Verify the
configured viewer and actual frames before claiming the run is visible. A
loopback link works only on the host machine. Clankie's Discord Activity is
another watch surface when configured. A viewer is not a Discord Go Live
screen share: inspect the active body's publishing capabilities and confirm
publication before saying you are sharing in the call.
