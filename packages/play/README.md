# @clankie/play

Clankie’s shared turn-based play kernel, model transport and durable trail for Pokémon and Minecraft.

This package holds no emulator. His body is a seat in a hosted PokeAgents
world ([ADR 0145](../../docs/adr/0145-the-world-is-the-only-body.md)), and
everything here sits above `GbaDriverIo` — one interface in
[`src/body-seam.ts`](src/body-seam.ts) that the seat implements. The loop never
learns what is behind it. The [Pokémon extension](../../integrations/pokemon/README.md)
owns its connector and execution composition through the shared game-extension
lifecycle; the [Minecraft adapter](../../integrations/minecraft/README.md) supplies its native play policy. This package retains the Pokémon adapter alongside their shared scheduler, transport and journal readers ([ADR 0254](../../docs/adr/0254-turn-based-games-share-a-play-kernel.md)).

## What is in here

| Module                 | What it owns                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `play-kernel.ts`       | Shared numbered turns, bounded proposal replacement, failure backoff and speech cooldown.                                                                        |
| `play-model.ts`        | Shared streamed model requests, deadlines, cancellation and provider pricing.                                                                                    |
| `play-journal.ts`      | One append-only identity/version envelope for native game payloads.                                                                                              |
| `free-play.ts`         | The Pokémon adapter: observe, decide, act, diff, record. Progress, stall detection, learned transitions, and the interjection queue.                             |
| `free-play-mind.ts`    | The model-backed decision-maker and the voice agent, built from the same persona so the two halves are one character.                                            |
| `free-play-voice.ts`   | What he says out loud, and when volition lets him ([ADR 0056](../../docs/adr/0056-voice-is-a-separate-agent-from-the-player.md)).                                |
| `free-play-journal.ts` | The append-only journal and compatible Pokémon/Minecraft readers ([ADR 0068](../../docs/adr/0068-a-playthrough-leaves-a-durable-trail.md)).                      |
| `play-journey.ts`      | Journey identity, and the notes and objective the next sitting inherits ([ADR 0126](../../docs/adr/0126-game-state-history-and-memory-have-separate-owners.md)). |
| `play-story.ts`        | The bounded story a journal projects for the console and captain.                                                                                                |

## Free play is a model, not an algorithm

[ADR 0049](../../docs/adr/0049-free-play-agency-and-non-deterministic-evidence.md)
defines free-play agency. Each turn Clankie receives the decoded state and the
action vocabulary and chooses; nothing here supplies a route. He returns a
bounded `monologue`, `intent`, `notes`, and one catalogued action, which the
world's own contract accepts or refuses.

The loop holds no save, load, or restart action. The world keeps the cartridge
and persists it through its own catalog, so his notes and objective are what
cross a sitting — never a rewindable savestate.

Sessions use the **rolling evidence policy**
([ADR 0061](../../docs/adr/0061-evidence-rolls-for-open-ended-play.md)): when
the bounded evidence window fills, it is sealed and a fresh one starts, with the
roll counted in the trace. Open-ended play never dies at a receipt-sized cap.

Pokémon sessions have a default 250,000 charged-token ceiling, configurable with
`clankie games budget` (see [CLI reference](../../docs/cli.md)).
Mind, voice and interrupted/repeated proposals all contribute to turn and summary
usage. Missing provider usage reserves 16,000 tokens; unknown prices stay null,
and a dollar cap fails closed. Thresholds are checked between calls, so one final
call can exceed a limit; these are estimated model costs, not invoice guarantees.

Each turn allows two voice preemptions, then finishes with later speech held in
a 32-slot FIFO. Overflow merges into its last bounded slot. The existing
`InterjectionQueue` default remains a latest-line slot for other consumers.
Before an action, decoded map/scene/battle/menu/dialog state is sampled again;
changed decision state gets at most two fresh proposals, then no action that turn.
Frame animation alone does not invalidate an action. Failed or invalid decisions
back off 1/2/4/8 seconds and stop after five consecutive failures; success resets
the counter. Retry waits observe a requested stop.

`onNotable` emits each kind once per sitting: stuck, two retired objectives,
model unavailable, world ended (at the service boundary), and exhausted usage.
The service queues these as information to the original conversation under its
existing grant. Delivery never gates the motor; terminal admission waits at most
two seconds. Clankie may guide the mind, speak to the room or stop. A missing
conversation or delivery failure is logged without redirecting it elsewhere.

## Running it

Clankie can start an installed local world through his machine tools, including
an authorized Discord voice handoff. The shipped
[`pokeagents` skill](../../.agents/skills/pokeagents/SKILL.md) covers checking
the endpoint, keeping `pokeagents start` in a persistent terminal, and joining
after readiness. The host, cartridges, and his own credentialed seat remain
separate prerequisites; joining alone does not start the world.

The captain is the parent of a sitting; this package is the driver. The
service's play host starts on the first join or explicit play observation,
reconciles any stale session, and joins the world when asked. Service boot does
not start its polling loop; observing alone does not join a world. The host
hands the joined seat to the loop here. To
watch a playthrough without a Discord ask, start
[`@clankie/discord-activity`](../../apps/discord-activity/README.md), point
`WORLD_ADDRESS` at a running world, and run:

```bash
CLANKIE_FREE_PLAY_TURNS=20 pnpm play:live
```

To read a journal after the fact:

```bash
pnpm --filter @clankie/play gameplay:evaluate-journal <journal.jsonl>
```

- `pnpm --filter @clankie/play test`
