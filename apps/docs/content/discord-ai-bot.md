# A Discord AI bot with voice

Run Clankie as your own Discord bot: talk in text, invite him into voice, and
let him keep the same character and memories across conversations. His service
runs on your computer, so it must stay awake and connected while he is there.

## Bring your own bot

[Install and set up Clankie](/get-started/) first. Create a bot in Discord's
Developer Portal, invite it to your server with the permissions it needs, and
connect it through the console. The
[Discord credential guide](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md#configure-discord)
gives the exact portal and token steps. Put the bot token into the setup
prompt, never a chat message or public issue.

In the console, `/discord` selects servers and rooms and who can ask for work.
`/persona` changes his name, character and how readily he joins a conversation.
Use “only reply when addressed” if you want a quieter bot. These choices are
explained in [Discord customization](/diy/#discord).

## Add voice

Use `/voice` to choose a voice stack and enter its provider keys. OpenAI
Realtime and Grok Voice have their own voice services; ElevenLabs can supply
speech for a configured brain. The Claude voice stack is experimental and
also needs transcription and speech providers. A coding-agent subscription
does not supply these voice keys.

Allow the voice server and channels in `/discord`, then ask him to join you.
His join policy decides who may invite him. Voice use may incur provider
charges separately from text chat.

```sh
clankie discord status
clankie voice status
```

These commands show the configured choices; they do not prove that a live
call works. Check in a room with people who have agreed to take part.

## Tell people about transcription

The default is explicit consent: each participant runs
`/clankie voice-consent opt-in` in Discord. If you choose presence-based
consent instead, tell everyone that being in the room counts as consent to
transcription. An explicit opt-out still wins. Transcript logging is off by
default; enabling it retains consented text locally, not raw audio.

## Decide who can ask for computer work

A server's Admin role controls server management; it does not make everyone
an owner of your machine. Configure ownership separately. Other participants
keep social tools. Mixed rooms withhold private work and fleet context, even
when you ask there. A machine's own access level still limits what can run.
See [Discord permissions](/diy/#who-gets-a-shell).

Next: [voice configuration](/diy/#voice),
[music and media](https://github.com/Volpestyle/clankie/blob/main/docs/discord-media.md),
or [Pokémon with a watch view](/pokemon-on-stream/).
