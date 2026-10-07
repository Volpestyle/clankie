# Customize Clankie

Make him yours: a name he answers to, a character you enjoy, a voice that
sounds right, and habits that fit your life. Models and connections can come
after.

New installation? Follow [Get started](/get-started/#diy-start-on-your-mac).
Everything here works from the console, and most of it from the [CLI](/cli/)
too; Clankie can run the commands for you. Keys go into the setup wizards,
never into a chat message or a command flag.

<a id="shape-his-character-and-skills"></a>

## Persona

“Keep your replies short, be curious, and use a little dry humor.” `/persona`
saves his name, aliases, character notes, and chattiness. The same character
follows him everywhere, with room to speak differently at work or among
friends. The [CLI equivalent](/cli/#persona-set-flags):

```bash
clankie persona set --display-name Clankie --aliases Clank,Clanks \
  --character-notes "Curious, a little dry, and happy to disagree." \
  --chattiness quiet --reply-policy addressed
```

Chattiness is `quiet`, `balanced`, or `chatty`. Reply policy decides which
Discord messages he sees (see [Discord](#discord)); he can always stay quiet.
`clankie persona status` shows what is saved and whether a restart is needed.

### A visual persona

Point him at a folder: “Use the images in ~/Pictures/clankie-vibe as your
persona,” or run
[`clankie persona images set ~/Pictures/clankie-vibe`](/cli/#persona-images-status-set-folder-clear).
Top-level images and videos shape his **vibe**; references in an `appearance/`
subfolder are what he draws himself from. Videos need ffmpeg and become contact
sheets. `clankie persona images status` shows what loaded; restart to apply. His
written character still wins, and the [persona images guide](https://github.com/Volpestyle/clankie/blob/main/docs/persona-images.md)
covers limits and privacy.

## Voice

`/voice` chooses how he sounds in Discord voice:

| Stack                  | Needs API keys for            |
| ---------------------- | ----------------------------- |
| OpenAI Realtime        | OpenAI                        |
| Grok Voice             | xAI                           |
| OpenAI with ElevenLabs | OpenAI and ElevenLabs         |
| Claude with ElevenLabs | Anthropic, OpenAI, ElevenLabs |

The Claude stack is experimental: OpenAI transcribes, Claude decides what to
say, and ElevenLabs speaks it. A chat subscription does not supply voice keys;
`/voice` stores them. Choose an ElevenLabs voice ID in `/voice`, then the
[voice CLI](/cli/#voice-status-voice-model-set-model-id-voice-model-clear) can
switch brains and speech models:

```bash
clankie voice status
clankie voice brain set anthropic
clankie voice model set eleven_v4_turbo
clankie restart clankie   # interrupts active calls
```

The [voice operating guide](https://github.com/Volpestyle/clankie/blob/main/apps/discord-bridge/README.md)
covers troubleshooting.

## Preferences

“Keep the team small and use efficient models. Ask Codex to implement, then
have another agent review.” `/fleet` saves how you like him to work: team size,
model budget, who commits, pushes, releases, and closes finished work, how work
is verified, and how reports read. Projects can override each choice.

```bash
clankie fleet set --size small --models efficient \
  --notes "Use Codex for implementation and another agent for review."
```

Sizes are `max`, `large`, `small`, and `solo`; models are `optimal` or
`efficient`. These guide his judgment rather than cap spending, and they install
or authorize nothing. Sign-ins, payments, and credentials always stay your
decision. The [fleet reference](/cli/#fleet-status-fleet-set-notes-text-size-size-models-mode-fleet-clear)
lists every field.

`/effort` sets reasoning effort, and `/routing` picks a lighter model for
everyday chat while keeping his main model for work.

## Skills

“Make a skill for how we review this project's changes.” Type `$` to browse
skills or `/skill-name task` to use one. Skills are reusable instructions; they
grant no credentials or access.

Add your own `SKILL.md` under `~/.agents/skills/my-skill/`, or a project's
`.agents/skills/`. He also reads his bundled skills and Pi's
`~/.pi/agent/skills`. Bundled names win, so pick distinct ones. Machine-wide
skills are found with `skill_search` when a task needs them rather than listed
every turn.

Every bundled skill, from leading hired agents to tidying finished panes, is
always on. `/skills` (or [`clankie skills`](/cli/#skill-setup)) lists them. The
[bundled-skills guide](https://github.com/Volpestyle/clankie/blob/main/docs/bundled-skills.md)
explains discovery.

<a id="hang-out-and-play"></a>

## Discord

“Hang out in our server, but only jump in when we address you.” `/discord`
connects a server with a **Participant** or **Admin** role and picks his rooms.
The quickest way in is the free **official Clankie bot**: sign in with
`clankie remote-access on`, run `clankie discord official on` and
`clankie restart`, then choose **Add to Discord** on your account page. No
developer portal, bot token or intents setup; Clankie still runs on your
machine with your own keys. The official bot has fair-use limits per account
and per server, and `clankie discord official` shows them. Creating your own
bot remains the advanced path, in the
[Discord connection guide](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md#configure-discord).

Reply policy `addressed` shows him messages that start with his name or mention
him, plus the next few after he replies (`--live-message-window`, default 5).
`all` shows him every admitted message. Neither forces a reply.
`clankie discord set --wake-trigger addressed|name|any` overrides it for text:
`addressed` is mentions and DMs only, `name` adds his name, `any` is every
message. Unset keeps the reply policy above.

```bash
clankie persona set --reply-policy addressed --chattiness quiet
clankie discord status
```

### The voice room

“Join me in voice.” Allow voice servers and channels in `/discord` and set up
his voice in `/voice`. With join policy `ambient` only configured participants
can invite him; `guild_members` lets members of allowed servers summon him. He
decides whether to greet the room, stay, or leave; ask him to leave anytime.

### Consent and transcripts

Voice consent defaults to `explicit`: each person runs
`/clankie voice-consent opt-in` in Discord. With `presence`, being in his
channel counts as consent, so **tell everyone in the room he transcribes**. An
explicit opt-out always wins ([ADR 0071](https://github.com/Volpestyle/clankie/blob/main/docs/adr/0071-presence-as-consent-voice-policy.md)).

Transcript logging is off by default. Turn it on in `/discord` (or
`--voice-transcript-logging-enabled on`) to keep consented speech and his
replies in a private local log, read with `/vt` or `clankie discord transcripts`.
Raw audio is never saved.

### Who gets a shell

Machine access is granted separately from room access, under `/discord` →
Advanced (`--system-actor-user-ids`, `--system-actor-guild-ids`,
`--system-actor-channel-ids`). It is a real shell as the service user; letting
him into a room grants none of it.

A granted person gets machine tools for their own turns in shared rooms and a
continuing work session in a DM with the official bot. A trusted server (or
selected channels in it) gives every admitted member a continuing work session.
Everyone else stays social. See [ADR 0105](https://github.com/Volpestyle/clankie/blob/main/docs/adr/0105-voice-is-as-capable-as-the-room-it-is-in.md)
and [ADR 0133](https://github.com/Volpestyle/clankie/blob/main/docs/adr/0133-a-machine-grant-belongs-to-a-discord-lane.md).

### Play and share

“Play Pokémon while we hang out.” He plays from his own seat in a PokeAgents
world, which needs a reachable world and his own
[world credential](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md#world-seat).
`clankie play status` shows the session, and the Discord Activity gives people
a live view. See the [play guide](https://github.com/Volpestyle/clankie/blob/main/packages/play/README.md).

Minecraft joins approved offline Java servers through `/minecraft`; his own
mind plays by default, or you can hand driving to a chosen agent. See
[Minecraft](https://github.com/Volpestyle/clankie/blob/main/docs/minecraft.md).

Ask for music once he is in voice; the
[media guide](https://github.com/Volpestyle/clankie/blob/main/docs/discord-media.md#youtube-music)
lists what to install. Watching screen shares and going Live need the
separately enabled personal-lab body.

## Then the plumbing

### Choose his models

`/setup` gets the first model working. Then `/model` changes it, `/auth`
manages provider sign-ins, and `/provider` adds custom providers such as a
local runtime. Chat, image (`/image-model`), video (`/video-model`), and voice
(`/voice`) are separate choices; a chat model alone enables none of the others.

For scripts, [`clankie model set provider/model`](/cli/#model-set-providerid-modelid),
[effort](/cli/#effort-status), [routing](/cli/#model-routing-status), and
[compaction](/cli/#model-compaction-status-model-compaction-set-tokens-model-compaction-default)
each have commands. The [model reference](https://github.com/Volpestyle/clankie/blob/main/packages/model-provider/README.md)
explains provider resolution.

### Bring your own team

“Implement this feature with Codex and have a second agent review it.” Clankie
himself runs on [pi](https://pi.dev); his workers can be Claude Code, Codex, Pi,
OpenCode, or Grok Build. Install and sign in to the ones you want on the machine
that runs them. [Herdr](https://herdr.dev) holds their real terminals, and
Clankie messages them through each harness's own channel, never by typing into
the pane.

A **machine** is where agents run; a **device** is a paired phone or desktop.
`/machines` or `clankie machines` lists them, and
`clankie machines add pc --ssh my-pc` adds another computer over SSH. See the
[machine reference](/cli/#runtime-setup) and the
[adapter guide](https://github.com/Volpestyle/clankie/blob/main/packages/agent-hosts/README.md)
for each harness's support and limits.

You can also sit in Clankie's seat from another harness: `clankie claude`,
`clankie codex`, `clankie opencode`, or `clankie grok` opens that tool as
Clankie, with his memory and tools ([seat commands](/cli/#seat-commands)).

### Give him ongoing work

```text
/goal Improve the project's onboarding guide and verify its examples
/autonomy on
```

A goal gives a conversation a lasting objective; autonomy lets him continue
across turns and wake himself. Neither adds tools or access. Goals default to a
1,000,000-token budget (`/goal --tokens N …` to change it), and `/goal` pauses,
resumes, or clears one. They run in Clankie's own conversations, not in a
harness seat, and are [console-only](/cli/#console-only-not-missing).
The service must keep running: [`clankie autostart enable`](/cli/#autostart-enable-autostart-disable-autostart-status)
starts it at login.

### Connect your services

`/connect` links GitHub, Linear, and Google. Gmail and Calendar are read-only;
Drive reads only the files you pick. [`clankie accounts`](/cli/#account-setup)
shows what is connected. His mailbox is his own address, not your inbox. The
[credential guide](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md)
covers storage and identity.

Work is tracked where the project already tracks it: Linear, GitHub issues, or
files ([work items](https://github.com/Volpestyle/clankie/blob/main/packages/work-items/README.md)).
Following Linear activity is a separate opt-in
([Linear setup](/cli/#linear-status-linear-follow-on-off)). Workers do not
inherit your accounts automatically; [worker access](https://github.com/Volpestyle/clankie/blob/main/docs/worker-access.md)
explains what they can reach.

### Work with your computer

“Find this in my browser and help me finish it.” Clankie browses with his own
profile (`/browser`, [`clankie browser`](/cli/#browser-harnesses-browser-delegate-on-off)).
Harder work in your own apps goes to an installed computer-use harness. The
[desktop-control reference](https://github.com/Volpestyle/clankie/blob/main/docs/desktop-control.md)
separates what is available from what is proven; installing Clankie grants no
macOS permissions on its own.

### Build on the open-source service

The console is one client. The [CLI](/cli/), [HTTP API](/api/), and
[`clankie mcp`](/cli/#mcp-lane-operator-conversation-id) expose the same
configuration and authorized tools to scripts and other agents. Start at the
[reference shelf](/reference/) and the
[architecture](https://github.com/Volpestyle/clankie/blob/main/docs/architecture.md).

The service is Apache-2.0, except the AGPL Discord media executable; the app and
hosted service are private ([license](https://github.com/Volpestyle/clankie#license)).
