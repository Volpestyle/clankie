# Customize Clankie

Run a persistent assistant on your own machine, choose how he thinks, and give
him the tools that fit your life. Start with a conversation; add a coding team,
a Discord room, or your own integrations when you have a use for them.

New installation? Follow [Get started](/get-started/#diy-start-on-your-mac).
This guide covers the optional parts of the Mac setup. The [Linux deployment](https://github.com/Volpestyle/clankie/blob/main/infra/hosted/README.md)
is an advanced alternative with a different capability set.

## Choose his models

`/setup` gets the first model working. Return to `/model` to change it,
`/auth` to manage provider sign-ins, and `/provider` for custom providers such
as a local runtime. Use the live picker for supported models and authentication
methods; provider support changes, and a subscription is not interchangeable
with every API.

His conversational model, image model, video model, and voice provider are
separate choices. `/image-model`, `/video-model`, and `/voice` configure their
own capabilities. A working chat model alone does not enable them. Credentials
belong in the interactive setup flows, not in a chat message or a command flag.

For scripts, the [CLI reference](/cli/) owns model selection, reasoning effort,
task-based routing, and compaction controls. The [model reference](https://github.com/Volpestyle/clankie/blob/main/packages/model-provider/README.md)
explains custom configuration and provider resolution.

## Shape his character and skills

Use `/persona` for his name and character. Non-secret settings have headless
CLI equivalents, so Clankie can help configure himself through supported commands.
The settings files are implementation details; use the console or CLI to change them.

Skills give him reusable instructions and tool knowledge. Type `$` in the console
to browse the loaded skills, or invoke one with `/skill-name task`. The service
reads its bundled skills and the supported project and user skill roots. A skill
provides guidance; it does not grant credentials or machine access.

Opinionated working skills are on by default. Use `/skills` in the console or
`clankie skills opinionated off` to disable that class; product and tool references
stay available. `clankie skills exclude NAME` disables one opinionated skill.
Start a fresh session after changing the selection to remove guidance already loaded.

The [bundled-skills guide](https://github.com/Volpestyle/clankie/blob/main/docs/bundled-skills.md)
owns the catalog, discovery paths, and which worker routes receive that guidance.

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

## Bring your own team

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

Try: “Help me implement this feature. Use Codex for the implementation and ask
a second agent to review the result.” Clankie still needs the corresponding
runtime and credentials to carry that out.

## Give him ongoing work

In the local console:

```text
/goal Improve the project's onboarding guide and verify its examples
/autonomy on
```

A goal gives that conversation a durable objective. Autonomy enables further
turns and scheduled wakes; it does not grant new tools or access. Use `/goal`
to inspect, pause, resume, or clear the goal, and `/autonomy off` to stop new
automatic continuations. An in-flight tool call may still finish. Set a token
budget when you need a bound; the [goal and autonomy reference](/cli/) owns
the exact syntax and status fields.

The service must remain running. For a Mac, `clankie autostart enable` starts
it at login; it does not keep the Mac awake.

## Connect your services

Use `/connect` for available account integrations. GitHub, Linear, and mailbox
connections have different setup and access rules. Clankie's mailbox connection
is his own address, not automatic access to your personal inbox. The
[credential guide](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md)
owns account identities and secret storage.

Work tracking follows the project's existing convention: Linear, GitHub issues,
or files. The [work-items package](https://github.com/Volpestyle/clankie/blob/main/packages/work-items/README.md)
explains discovery. Following Linear notifications is a separate opt-in from
connecting the account; use the [setup reference](/cli/#linear-status-linear-follow-on-off).

Workers do not automatically inherit every connected account. [Worker access](https://github.com/Volpestyle/clankie/blob/main/docs/worker-access.md)
describes explicit, restricted grants and the current isolation limits.

## Hang out and play

| Add                             | Start here                                                                                   | What else it needs                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord text                    | `/discord`                                                                                   | Your official bot and the chosen servers/channels; [setup](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md#configure-discord).                     |
| Discord voice and music         | `/voice`, then ask him to join                                                               | A voice provider and the active Discord body; music has [additional executables](https://github.com/Volpestyle/clankie/blob/main/docs/discord-media.md#youtube-music). |
| Private voice on the Mac        | [Menu-bar app](https://github.com/Volpestyle/clankie/blob/main/apps/menu-bar/README.md)      | Local service, voice setup, and microphone permission.                                                                                                                 |
| Pokémon and a live viewer       | [Play guide](https://github.com/Volpestyle/clankie/blob/main/packages/play/README.md)        | A reachable PokeAgents world, his own world credential, and optional Discord Activity setup.                                                                           |
| Screen-share watching / Go Live | [Discord media guide](https://github.com/Volpestyle/clankie/blob/main/docs/discord-media.md) | The separately enabled personal-lab body; the official bot cannot receive those pixels or publish Go Live.                                                             |

Clankie does not include a local Pokémon emulator. Each player has their own
world seat. The [world credential instructions](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md#world-seat)
describe the current setup gap as well as the supported connection.

Discord machine-control grants are separate from joining a room. Ordinary
social participation does not give someone your shell. Review those grants in
the Discord setup flow before allowing a room to operate the machine.

## Work with your computer

Clankie has his own browser profile for browsing tasks. Harder work in your
existing apps can go to an installed computer-use harness. Native macOS control
also has a Peekaboo path with documented limits. The [desktop-control reference](https://github.com/Volpestyle/clankie/blob/main/docs/desktop-control.md)
distinguishes available tools from proven behavior; installing Clankie does not
silently grant macOS permissions or guarantee background input isolation.

## Build on the open-source service

The console is one client of the service. A headless CLI, HTTP API, and MCP
projection expose configuration and authorized tools for scripts, integrations,
and other agent seats. Start with the [reference index](/reference/), then
the [architecture](https://github.com/Volpestyle/clankie/blob/main/docs/architecture.md)
and [contributor guide](https://github.com/Volpestyle/clankie/blob/main/CONTRIBUTING.md).

The public service is Apache-2.0 except the separately licensed AGPL native
Discord media executable. The companion app and managed service have separate,
private sources. The [repository license section](https://github.com/Volpestyle/clankie#license)
states the boundary.
