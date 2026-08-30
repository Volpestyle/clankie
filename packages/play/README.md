# @clankie/play

The half of Clankie that plays a Pokémon game, and the durable trail it leaves.

This package holds no emulator. His body is a seat in a hosted PokeAgents
world ([ADR 0145](../../docs/adr/0145-the-world-is-the-only-body.md)), and
everything here sits above `GbaDriverIo` — one interface in
[`src/body-seam.ts`](src/body-seam.ts) that the seat implements. The loop never
learns what is behind it.

## What is in here

| Module                 | What it owns                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `free-play.ts`         | The turn loop: observe, decide, act, diff, record. Progress, stall detection, learned transitions, and the interjection queue.                                   |
| `free-play-mind.ts`    | The model-backed decision-maker and the voice agent, built from the same persona so the two halves are one character.                                            |
| `free-play-voice.ts`   | What he says out loud, and when volition lets him ([ADR 0056](../../docs/adr/0056-voice-is-a-separate-agent-from-the-player.md)).                                |
| `free-play-journal.ts` | The append-only V3 journal every sitting writes ([ADR 0068](../../docs/adr/0068-a-playthrough-leaves-a-durable-trail.md)).                                       |
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

## Running it

The captain is the parent of a sitting; this package is the driver. The
service's play host joins the world and hands the seat to the loop here. To
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
