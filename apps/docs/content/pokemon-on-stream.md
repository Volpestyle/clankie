# An AI that plays Pokémon on stream

Clankie can play Pokémon while you watch and talk to him. He chooses what to
do from the game state, remembers the journey between sittings, and can talk
about what is happening. Give him a goal such as “Get ready for the next gym”
or ask why he made a move.

## What you need

Start with [Clankie on your own computer](/get-started/). Pokémon also needs a
reachable PokeAgents world and Clankie's own seat credential for that world.
The install does not include a local emulator, a game ROM or a ready-made
world. Configure the [world seat](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md#world-seat)
before asking him to play. Model use may cost money through your provider.

For conversation while he plays, set up [Discord and voice](/discord-ai-bot/).
Playing, speaking and showing the game are separate pieces: a working text
chat does not mean all three are configured.

## Start a sitting

Ask Clankie to play in your owner conversation: “Play Pokémon for a while and
tell me how the team is doing.” Give a suggestion when you want to change
course. He decides the individual moves.

```sh
clankie play status
clankie play stop
```

Status shows the live session. Stop asks him to finish at the next turn
boundary. The [play reference](/cli/#play-status) covers the command details.

## Watch with friends

The Discord watch-me-play Activity shows the current game and overlay, with
game sound after a viewer enables it. It needs the Activity viewer and game
producer configured for your bot; inviting a bot alone does not supply them.
The [Activity guide](https://github.com/Volpestyle/clankie/blob/main/apps/discord-activity/README.md)
and [Discord media reference](https://github.com/Volpestyle/clankie/blob/main/docs/discord-media.md)
cover that setup and who may watch.

This embedded view is different from publishing a Discord Go Live stream.
Go Live and screen watching require the separately enabled personal-lab
body; see the media reference before choosing that route.

## Recordings

There are no VODs linked here yet. A live session or a screenshot is not a
recorded playthrough. This page will link recordings when they are available.

For the play model and its saved journey, see the
[play guide](https://github.com/Volpestyle/clankie/blob/main/packages/play/README.md).
