# Customize Clankie

Make him yours: a name he answers to, a character you enjoy, a voice that sounds
right, and habits that fit your life. Start with what you want him to be like;
the models and connections can come after.

New installation? Follow [Get started](/get-started/#diy-start-on-your-mac).
This guide covers customization on your own Mac. Use the console or supported
CLI commands to change settings; Clankie can help you run them. Keep API keys
in the setup wizards, never in a chat message.

<a id="shape-his-character-and-skills"></a>

## Persona

“Keep your replies short, be curious, and use a little dry humor.” Open `/persona`
to save his name, aliases, and character notes. The same character follows him
across conversations, with room to speak differently at work or among friends.

The [CLI equivalent](/cli/#persona-set-flags) is:

```bash
clankie persona set --display-name Clankie --aliases Clank,Clanks \
  --character-notes "Curious, a little dry, and happy to disagree." \
  --chattiness quiet --reply-policy addressed
```

Chattiness can be `quiet`, `balanced`, or `chatty`. Reply policy controls which
messages he sees in admitted Discord text channels: `addressed` starts with his
name or a mention and lets him follow a few messages after replying; `all`
lets him read every admitted message.
Neither makes him answer every message. He can always stay quiet.

[`clankie persona status`](/cli/#persona-status) shows what you saved. Follow
the returned restart instruction to apply character changes.

## Look and vibe

### Give him a visual persona

Point him at a folder in the console: “Use the images in ~/Pictures/clankie-vibe
as your persona.” Or run [`clankie persona images set ~/Pictures/clankie-vibe`](/cli/#persona-images-status-set-folder-clear).

Files in the folder shape his **vibe**—the feel of who he is, not what he looks
like. Put references for his physical appearance in an **`appearance/` subfolder**;
those are the ones he uses for self-portraits. Videos work too: with ffmpeg and
ffprobe installed, each becomes one contact sheet of ten chronological frames.

Run [`clankie persona images status`](/cli/#persona-images-status-set-folder-clear)
to see what loaded and find the contact-sheet paths. Restart Clankie to apply
the selection or changes to the files. His written character still takes precedence.

## Voice

Open `/voice` → **Voice stack** to choose how he sounds. Realtime voice handles
listening and conversation; speech output is the voice you hear. Choose OpenAI
Realtime or Grok Voice for their native voices, or ElevenLabs for an external
voice speaking the text OpenAI produces. ElevenLabs currently pairs with OpenAI,
not Grok Voice.

For ElevenLabs, paste a voice ID from your ElevenLabs voice library and choose
its model in `/voice`. You need both an OpenAI API key and an ElevenLabs API key.
Native OpenAI or Grok voice needs that provider's API key. The wizard stores
keys in the credential broker; a chat-model subscription alone does not supply them.

Once ElevenLabs is configured, the [voice CLI](/cli/#voice-status-voice-model-set-model-id-voice-model-clear)
can inspect it and change its model:

```bash
clankie voice status
clankie voice model set eleven_v4_turbo
```

`eleven_v4_turbo` selects the dialogue speech model. An unset model keeps
`eleven_flash_v2_5`; `clankie voice model clear` restores that default. Check
`effectiveVoice` in status for environment overrides, then
[`clankie restart clankie`](/cli/#restart-service) when you're ready to interrupt
active calls. Provider and voice-ID selection still need `/voice`; there is no
headless setter for them.

Use this voice setup for a [Discord voice room](#discord). The [voice operating guide](https://github.com/Volpestyle/clankie/blob/main/apps/discord-bridge/README.md)
has setup and troubleshooting details.

## Preferences

“Keep the team small and use efficient models. Ask Codex to implement, then
have another agent review.” Open `/fleet` to save how you like him to work.
The [fleet CLI](/cli/#fleet-status-fleet-set-notes-text-size-size-models-mode-fleet-clear)
lets you set the same preferences:

```bash
clankie fleet set --size small --models efficient \
  --notes "Use Codex for implementation and another agent for review."
```

Sizes are `max`, `large`, `small`, and `solo`; model preferences are `optimal`
or `efficient`. These are targets for his judgment, not hard worker or spending
caps. They do not install a harness or give it credentials.

Use `/effort` to pick a reasoning level supported by his model. The CLI is
[`clankie effort set LEVEL`](/cli/#effort-set-level-model-provider-model-effort-clear-model-provider-model).
Use `/routing` to choose a routine model for everyday chat while keeping his
main model for work. The CLI equivalent is
[`clankie model routing set provider/model`](/cli/#model-routing-status), using
a model from your catalog; `clankie model routing status` shows the result.

Opinionated working skills are on by default. `/skills` lets you turn them off
or back on; the CLI equivalents are [`clankie skills opinionated off` and
`clankie skills opinionated on`](/cli/#skill-setup). Product and tool references
stay available. Start a fresh session to drop guidance already loaded.

## Skills

“Make a skill for how we review this project's changes.” Type `$` in the console
to browse available skills, or `/skill-name task` to use one. Skills give him
reusable instructions and tool knowledge; they do not grant credentials or
machine access.

Add your own `SKILL.md` in `~/.agents/skills/my-skill/`, or in a project's
`.agents/skills/my-skill/` for conversations working in that project. He also
reads his bundled roots and the skills directory under Pi's agent directory
(normally `~/.pi/agent/skills`). Use a distinct name: bundled names take precedence.
Skills from those machine-wide folders are not listed on every turn; he finds
them with `skill_search` when a task calls for one, and `/skill-name` still works.

For the bundled selection, use `/skills` or the [skills CLI](/cli/#skill-setup):

```bash
clankie skills
clankie skills exclude reflect
clankie skills include reflect
```

Only bundled opinionated skills can be excluded; product and repo-authored
skills stay on. `include` removes that exclusion but does not turn the whole
class back on. There is no CLI skill installer: adding your own skill means
adding its files. Start a fresh session and reopen the console to refresh its
picker. The [bundled-skills guide](https://github.com/Volpestyle/clankie/blob/main/docs/bundled-skills.md)
explains discovery and which worker routes receive the guidance.

<a id="hang-out-and-play"></a>

## Discord

“Hang out in our server, but only jump in when we address you.” Use `/discord`
to choose his servers and channels, and `/persona` for reply policy and
chattiness. For a quieter room:

```bash
clankie persona set --reply-policy addressed --chattiness quiet
clankie discord status
```

The [persona flags](/cli/#persona-set-flags) control his conversational habits;
the [Discord CLI](/cli/#discord-set-field-value-discord-clear-field) controls
where he participates. With reply policy `addressed`, `--live-message-window` sets
how many messages he follows live after his last reply (default 5), before
later messages wait for a catch-up. Zero removes that live follow-up window;
`all` reads every admitted message regardless. It controls what he sees, never
what he must say.
For tokens and first setup, follow the [Discord connection guide](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md#configure-discord).

### The voice room

“Join me in voice.” Configure the allowed voice servers and channels in
`/discord`, then use `/voice` for his speech setup. The equivalent
[Discord fields](/cli/#discord-set-field-value-discord-clear-field) include
`--voice-enabled`, `--voice-guild-ids`, `--voice-channel-ids`, and
`--voice-channel-id`. `--voice-join-policy ambient` keeps invitations with the
configured ambient participants; `guild_members` lets members of allowed
servers summon him, subject to the channel rules.

When you invite him, he can answer in text, greet the room aloud, or arrive
quietly. Room joins and departures give him context to decide whether to stay,
speak, or leave; an empty room does not start an automatic leave timer.
You can ask him to leave, too. [Voice behavior](https://github.com/Volpestyle/clankie/blob/main/apps/discord-bridge/README.md#body-behavior)
has the details; joining and leaving are conversation actions, not standalone
`clankie` CLI commands.

### Consent and the transcript log

Use `/discord` to choose voice consent. The default is `explicit`: each
participant runs `/clankie voice-consent opt-in` in Discord for the active
session. With `presence`, being in his active voice channel counts as consent.
**The owner handles disclosure**: everyone in that room should know he
transcribes while he is there. An explicit `/clankie voice-consent opt-out`
always wins under either policy. [ADR 0071](https://github.com/Volpestyle/clankie/blob/main/docs/adr/0071-presence-as-consent-voice-policy.md)
explains that choice.

The [CLI equivalent](/cli/#discord-set-field-value-discord-clear-field) is
`clankie discord set --voice-consent-policy explicit`; choose `presence` only
for a room whose participants understand it.

Full transcript logging is off by default. Enable it in `/discord`, or with
`clankie discord set --voice-transcript-logging-enabled on`, then open `/vt`
in the console to read it, or run `clankie discord transcripts`. It retains
consented speech and Clankie's generated reply wording in a private local log,
separate from the content-free receipts. Replies carry playback outcomes;
interrupted text may include an unheard ending. No raw audio is saved. Turn it off with the same flag
set to `off`. The [voice log reference](https://github.com/Volpestyle/clankie/blob/main/apps/discord-bridge/README.md#configure)
covers its location. Check [`clankie discord status`](/cli/#discord-status)
for effective settings and the restart instruction.

### Who gets a shell

Use `/discord` to review machine-access grants separately from room access.
The [CLI fields](/cli/#discord-set-field-value-discord-clear-field) are
`--system-actor-user-ids`, `--system-actor-guild-ids`, and
`--system-actor-channel-ids`. These grant real machine tools, including a shell
running as the Clankie service user. Simply letting him read or join a room
grants none of that access.

An individually granted person gets machine tools in text and voice. In a
shared room, that grant lasts for their turn; the next speaker does not inherit
it. An official-bot DM with that person can keep a continuing work session.
A trusted guild grant gives every admitted human in its scope machine access;
the channel list can narrow it to selected rooms. Those rooms keep a separate,
continuing work session. Everyone else stays social. See [ADR 0105](https://github.com/Volpestyle/clankie/blob/main/docs/adr/0105-voice-is-as-capable-as-the-room-it-is-in.md)
and its [lane-grant update](https://github.com/Volpestyle/clankie/blob/main/docs/adr/0133-a-machine-grant-belongs-to-a-discord-lane.md).

### Play and share

“Play Pokémon while we hang out.” Start with the [play guide](https://github.com/Volpestyle/clankie/blob/main/packages/play/README.md);
[`clankie play status`](/cli/#play-status) shows his current session. He needs
a reachable PokeAgents world and his own [world credential](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md#world-seat),
not a local emulator. The optional Discord Activity gives people a live viewer.

Ask for music once he is in voice; the [media guide](https://github.com/Volpestyle/clankie/blob/main/docs/discord-media.md#youtube-music)
lists the extra executables. Screen-share watching and Go Live require the
separately enabled personal-lab body; the official bot cannot receive those
pixels or publish Go Live.

## Then the plumbing

### Choose his models

`/setup` gets the first model working. Return to `/model` to change it,
`/auth` to manage provider sign-ins, and `/provider` for custom providers such
as a local runtime. Use the live picker for supported models and authentication
methods; provider support changes, and a subscription is not interchangeable
with every API.

His conversational model, image model, video model, and voice provider are
separate choices. `/image-model`, `/video-model`, and `/voice` configure their
own capabilities. A working chat model alone does not enable them. Credentials
belong in the interactive setup flows, not in a chat message or a command flag.

For scripts, [`clankie model set provider/model`](/cli/#model-set-providerid-modelid)
selects his conversational model. [Reasoning effort](/cli/#effort-status),
[routing](/cli/#model-routing-status), and [compaction](/cli/#model-compaction-status-model-compaction-set-tokens-model-compaction-default)
have their own controls. The [model reference](https://github.com/Volpestyle/clankie/blob/main/packages/model-provider/README.md)
explains custom configuration and provider resolution.

### Bring your own team

“Help me implement this feature. Use Codex for the implementation and ask
a second agent to review the result.” Open `/connections`; its
[CLI equivalent is `clankie connections`](/cli/#connections-and-runtime).

Clankie's built-in service runs on [pi](https://pi.dev). Worker agents can use
different supported harnesses, including Claude Code, Codex, and pi. Install
and authenticate the harnesses you want on the machine that runs them. Choosing
a worker harness does not replace Clankie's own model or runtime.

Open `/connections` to inspect execution runtimes, Swarm connections, and
accounts. **Swarm** carries messages and task ownership; **Herdr** supplies
the terminals for the built-in worker routes. The release includes Herdr.
Its optional UI plugin makes the console and fleet board convenient to open
inside Herdr, but is not required to hire workers.

You can connect an existing runtime or coordinator, approve project directories
for workers, and reach agents on other machines. Managed spawning and peer
communication have different requirements. The [Swarm support table](https://github.com/Volpestyle/clankie/blob/main/packages/swarm/README.md#support-at-a-glance)
names the implemented routes and limits; the [connection commands](/cli/#connections-and-runtime)
own their setup.

### Give him ongoing work

In the local console:

```text
/goal Improve the project's onboarding guide and verify its examples
/autonomy on
```

A goal gives that conversation a durable objective. Autonomy enables further
turns and scheduled wakes; it does not grant new tools or access. Use `/goal`
to inspect, pause, resume, or clear the goal, and `/autonomy off` to stop new
automatic continuations. An in-flight tool call may still finish. Set a token
budget when you need a bound; the [console reference](/console/) owns
the exact syntax. These are [console controls](/cli/#console-only-not-missing),
with no standalone headless goal or autonomy command.

The service must remain running. For a Mac, [`clankie autostart enable`](/cli/#autostart-enable-autostart-disable-autostart-status) starts
it at login; it does not keep the Mac awake.

### Connect your services

Use `/connect` for available account integrations;
[`clankie accounts`](/cli/#accounts-list-accounts-connect-github-accounts-disconnect-provider-accounts-apps)
inspects connected GitHub and Linear accounts. Secret entry stays in the console.
GitHub, Linear, and mailbox connections have different setup and access rules. Clankie's mailbox connection
is his own address, not automatic access to your personal inbox. The
[credential guide](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md)
owns account identities and secret storage.

Work tracking follows the project's existing convention: Linear, GitHub issues,
or files. The [work-items package](https://github.com/Volpestyle/clankie/blob/main/packages/work-items/README.md)
explains discovery. Following Linear notifications is a separate opt-in from
connecting the account; use the [setup reference](/cli/#linear-status-linear-follow-on-off).

His work-tracking guidance prefers useful visual evidence: screenshots or short
clips of tangible results, charts of measured data, and diagrams of systems and
flows. Visuals belong on the relevant work item with captions explaining what
they show; proposals and sample data are labeled, with tests and source links
supporting claims about completed work.

Workers do not automatically inherit every connected account. [Worker access](https://github.com/Volpestyle/clankie/blob/main/docs/worker-access.md)
describes explicit, restricted grants and the current isolation limits.

### Work with your computer

“Find this in my browser and help me finish it.” Use `/browser` to inspect his
browser settings; [`clankie browser harnesses`](/cli/#browser-harnesses-browser-delegate-on-off)
lists the computer-use harnesses he can hire.

Clankie uses Browser Use Pi with his own browser profile for browsing tasks.
Machine-authorized turns can keep JavaScript variables and helpers between
browser calls; ordinary social turns have browser-only tools. Inspect them
with `clankie browser tools`. Harder work in your
existing apps can go to an installed computer-use harness. Native macOS control
also has a Peekaboo path with documented limits. The [desktop-control reference](https://github.com/Volpestyle/clankie/blob/main/docs/desktop-control.md)
distinguishes available tools from proven behavior; installing Clankie does not
silently grant macOS permissions or guarantee background input isolation.

### Build on the open-source service

“Help me build an integration with your service.” Start with
[`clankie status`](/cli/#health-status) to check the running services, or
[`clankie mcp`](/cli/#mcp-lane-operator-conversation-id) for an MCP client.

The console is one client of the service. A headless CLI, HTTP API, and MCP
projection expose configuration and authorized tools for scripts, integrations,
and other agent seats. Start with the [reference index](/reference/), then
the [architecture](https://github.com/Volpestyle/clankie/blob/main/docs/architecture.md)
and [contributor guide](https://github.com/Volpestyle/clankie/blob/main/CONTRIBUTING.md).

The public service is Apache-2.0 except the separately licensed AGPL native
Discord media executable. The companion app and managed service have separate,
private sources. The [repository license section](https://github.com/Volpestyle/clankie#license)
states the boundary. The [Linux deployment](https://github.com/Volpestyle/clankie/blob/main/infra/hosted/README.md)
is an advanced alternative to the Mac setup, with a different capability set.
