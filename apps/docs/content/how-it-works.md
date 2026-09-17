# How Clankie works

Clankie is your persistent lead agent, running on your machine. Start in his terminal console, give him work, and choose the worker harnesses he coordinates through Herdr. The lead runs on [pi](https://pi.dev); Claude Code, Codex, and other supported harnesses run as workers in their own terminal panes. Choosing a worker harness does not change the lead's runtime.

The service owns Clankie's durable conversations, goals, memory, tools, and device access. The TUI and companion app reach that same service, so you can direct work at your desk and follow it from your phone while the host remains awake and online. Discord, voice, media generation, and play extend what Clankie can do.

<div class="diagram" role="img" aria-label="Surfaces reach one local service, which reaches models, a browser, a herdr fleet, a PokeAgents world, and connected services. State stays on your machine.">
  <div class="diagram-col">
    <h4>Surfaces</h4>
    <div class="dnode"><strong>Console</strong><span>primary workspace with the lead</span></div>
    <div class="dnode"><strong>iPhone / iPad app</strong><span>Messages · Terminal · Commons</span></div>
    <div class="dnode"><strong>Discord</strong><span>one active body, text and voice</span></div>
    <div class="dnode"><strong>Menu bar</strong><span>private local voice</span></div>
  </div>
  <div class="diagram-col diagram-center">
    <h4>The service</h4>
    <div class="dnode dnode-main"><strong>Clankie, the lead</strong><span>pi · goals · tools · memory</span><span>HTTP on 127.0.0.1:4310</span></div>
    <div class="dnode"><strong>On your machine</strong><span>Keychain credential broker</span><span>~/.clankie · ~/.config/clankie</span></div>
  </div>
  <div class="diagram-col">
    <h4>What he reaches</h4>
    <div class="dnode"><strong>Models</strong><span>any provider, or a local runtime</span></div>
    <div class="dnode"><strong>Browser</strong><span>agent-browser, his own profile</span></div>
    <div class="dnode"><strong>Herdr workers</strong><span>your choice of installed harnesses</span><span>real sessions in visible panes</span></div>
    <div class="dnode"><strong>PokeAgents world</strong><span>his own seat, watched live</span></div>
    <div class="dnode"><strong>Linear · email</strong><span>connected by the owner</span></div>
  </div>
</div>

## One service, launcher-owned

`clankie` with no arguments starts the service if it is not running and opens the console. The launcher supervises the long-lived local processes and starts them in dependency order: the service, the relay for the app, the one Discord body you selected (which owns a native media child for voice), and the optional watch-me-play surface. `clankie restart [service]` and `clankie down [service]` name them; `clankie autostart enable` makes the same start happen at login. The service stays up when a console exits, so several consoles, the app, and Discord can be open at once.

The captain runs on pi: models, sessions, tools, skills, and compaction are pi's. Clankie adds who he is, the rooms he lives in, the bodies he can put on, and the authority each caller carries.

## Three views of the same work

| View         | Use it to                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Messages** | Give Clankie direction, talk to individual workers, and read shared conversations and tool activity. Agent contacts outlive their current terminal sessions.              |
| **Terminal** | Open the real Herdr pane behind an agent. Observe its output or use direct input when the paired device has control permission.                                           |
| **Commons**  | See workers grouped by working directory, their activity, who spawned whom, and recent message exchanges. Tap a figure to chat, open its terminal, or reach its controls. |

Commons is a practical map of the live fleet. Its figures and relationships come from the same host snapshot that supplies the other views. When the connection is lost, live figures disappear rather than continuing to act out stale activity. Decoration and camera preferences belong to the app.

A figure becoming idle means its turn stopped; it does not prove a test passed. A celebration is an agent's statement about its work. Use the conversation and terminal to inspect the supporting results.

## Rooms, not agents

The console, Discord text channels, voice channels, and gameplay are rooms, not separate agents. Each room is a lane with its own continuing pi session that survives restarts — operator conversations, voice channels, and text channels each keep a durable tree under `~/.clankie/captain/`. He can read his other rooms, and his persona is owner-authored settings that no caller can change.

Where you type `clankie` decides which room opens: a launch inside a project creates a conversation for that project and his tools run there; `/conversation` and `/cd` move between them. `/new` starts a fresh one; `/btw` forks an ephemeral side question and throws it away on `Ctrl+C`.

## How a message becomes a turn

Every surface speaks the same operator-conversation contract, `POST /operator/v1/dispatch`: list, create, send, replay, tail, cancel, fork, close, autonomy. The console and the app both use it. A tail carries the settled events plus the message he is typing right now, so a console shows him typing.

A Discord message reaches the active body, which posts it to `POST /v1/captain/channel-turns`. The service fences the untrusted body, resolves images to bytes at the last hop, attaches channel context, and prompts that room's session. A message that arrives while he is already answering steers into the running turn instead of queueing a second reply. Replying with silence sends nothing: silence is a real answer. Nothing caps how long a turn takes, but a turn that emits no event for five minutes is a dead stream and is settled as stalled.

## What he can do, and from where

- **Coding tools.** Read, bash, edit, and write are pi built-ins. They attach to the console, and to Discord turns from people on the machine-grant allowlists (`discord.systemActorUserIds`, trusted guilds or channels). Everyone else stays social. Voice is as capable as the room it is in.
- **Browser.** A persistent `agent-browser` profile that holds his own accounts. He can hand the window over on your screen for a signup or a CAPTCHA.
- **Pictures and video.** One provider-neutral seam over OpenAI, Google, and Grok; `/image-model` and `/video-model` pick the models.
- **Leading agents.** He leads coding agents through the herdr CLI over bash, guided by skills. There is no worker protocol: he delegates, watches, and reports what actually happened. `clankie herdr set --session` picks the session he leads; the herdr-lead board is the companion dashboard.
- **Playing.** His body is a separately credentialed seat in a hosted PokeAgents world; the play mind in `packages/play` drives it, frames flow to the Discord Activity, and voice commentary rides the run. Other agents join the same world through PokeAgents' own doors and get their own seats. Nobody takes his body.

Model output, Discord bodies, images, and web content are untrusted input. They never become instructions.

## Memory

He keeps a bounded ring of self-authored episodes and per-person facts about the people he talks to under `~/.clankie/memory/`. Before each run a hidden host extension reads the newest recall card into the prompt, filtered by lane — operator-private notes never reach a Discord room. `/memory` in the console browses, edits, and forgets that store through operator-only routes; `clankie memory-card` prints the card a lane's next run will see.

## Goals and self-wakes

`/goal <objective>` gives a conversation a durable goal; `--tokens` caps it. Continuations run through the same session and event log as your own messages, so every tool call stays visible. `/autonomy on|off` is the global switch for goal continuations and scheduled self-wakes. He proposes goals in chat; proposals never activate themselves.

## Optional: a different operator seat

The TUI's pi-based Clankie is the primary lead. Separately, `clankie seat` opens Claude Code on your own plan as an alternative operator seat, with Clankie's identity, tools, memory card, and skills supplied by the service. Wakes, Herdr completion watches, and head-conversation messages can reach that seat; goal continuations and Linear hook turns remain in pi. Social lanes also remain in the service. This alternative is not required to use Claude Code as a worker. The [plugin guide](https://github.com/Volpestyle/clankie/blob/main/integrations/claude-plugin/README.md) describes setup and limitations.

## Where secrets live

The credential broker (Keychain on macOS, service `bot.clankie.credentials`) is the only secret store. `/auth` writes provider keys and OAuth logins; `/discord`, `/connect`, and `/voice` write body and service credentials; the CLI never accepts a secret as a flag. Non-secret model configuration is `~/.config/clankie/clankie.json` and owner settings (persona, Discord ids, allowlists) are `~/.config/clankie/settings.json`; both are written through `clankie <noun> set` or the matching console command, never by hand.

## The doorway

The app does not move Clankie into a cloud. Your machine signs in to one account with an email one-time code (`/gateway`), then holds one outbound WebSocket to `api.clankie.bot` carrying that account's access token. The gateway verifies the token, derives your machine's route from the account plus a per-installation id, and forwards bounded exchanges; it keeps no account, host, or message database. Pairing is a single-use offer minted by your machine (`clankie pair`); the device credential and every grant it carries are decided on your machine. The [network page](/network/) lists the exact public routes, and the [HTTP API](/api/) is the full local contract underneath.

When push is configured, the gateway keeps a separate delivery database with APNs tokens, routing identifiers, delivery-key hashes and versioned revocations. The app authorizes that delivery; its machine holds only the registration reference. A wake contains a fixed alert and host/conversation identifiers, never a message excerpt. Pairing and messaging work without push configuration.

## Read deeper

- [Architecture](https://github.com/Volpestyle/clankie/blob/main/docs/architecture.md) — the canonical diagram and where each concern lives
- [Decision records](https://github.com/Volpestyle/clankie/blob/main/docs/adr) — why each boundary is where it is
- [Credentials](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md) — who holds which secret
- [Memory](https://github.com/Volpestyle/clankie/blob/main/docs/memory.md) — what each store holds and who may read it
- [Distribution](https://github.com/Volpestyle/clankie/blob/main/docs/distribution.md) — the installed layout and releases
