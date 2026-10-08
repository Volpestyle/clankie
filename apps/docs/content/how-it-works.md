# How Clankie works

Clankie lives in a persistent service on one machine: yours, or a private hosted
one. The app, the terminal console, and Discord are ways to reach him. The
service owns his conversations, memory, tools, and access, so closing a client
loses nothing.

You can use him without knowing any of this. It helps when you want to
customize him, connect a team, or know where your work goes.

<div class="diagram" role="img" aria-label="The app and console, plus optional Discord text and voice, reach Clankie's persistent service. The service stores conversations and memory and uses configured models, tools, and agent connections. Capabilities depend on the host.">
  <div class="diagram-col">
    <h4>Talk to him</h4>
    <div class="dnode"><strong>The app</strong><span>Messages · Commons · Terminal</span></div>
    <div class="dnode"><strong>The console</strong><span>local or hosted connection</span></div>
    <div class="dnode"><strong>Optional rooms</strong><span>Discord text · voice</span></div>
  </div>
  <div class="diagram-col diagram-center">
    <h4>His home</h4>
    <div class="dnode dnode-main"><strong>Clankie's service</strong><span>conversations · memory · goals</span><span>tools · credentials · access</span></div>
    <div class="dnode"><strong>On his host</strong><span>your machine or a managed machine</span></div>
  </div>
  <div class="diagram-col">
    <h4>His connections</h4>
    <div class="dnode"><strong>Models and tools</strong><span>chosen for the task</span></div>
    <div class="dnode"><strong>Helper agents</strong><span>native harnesses in Herdr</span></div>
    <div class="dnode"><strong>Optional services</strong><span>accounts · browser · media · play</span></div>
  </div>
</div>

## One identity, many conversations

There is one Clankie. A chat in the app, a project in the console, and a Discord
room each have their own history and permissions, but the same character. What
is said in one room does not leak into another.

His built-in agent runs on [pi](https://pi.dev), which handles models, sessions,
tools, skills, and compaction. Clankie adds the lasting identity, memory, his
connections, and the authority each caller brings.

Other harnesses can take his seat: `clankie claude`, `clankie codex`,
`clankie opencode`, and `clankie grok` open that tool as Clankie, with his
persona, memory, and tools, on a chat of their own or an existing one
([seat commands](/cli/#seat-commands)). While a seat is open, worker reports and
wakes for its chat go to it; when it closes, pi takes over again.

Requests from Discord text or voice run as their own visible threads under
Clankie, several at once, and the answer returns to the room that asked.

## History, memory, and goals

| Store                | What it gives you                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Conversation history | The thread you return to: messages, visible tool work, and delivered files.                    |
| Memory               | Selected experiences and facts for later conversations, kept until forgotten.                  |
| Goal                 | An objective you approve that he keeps working on, within a token budget, when autonomy is on. |

Memory recall is filtered by who is asking: private operator notes never reach
a social Discord room. Goals and self-wakes use the conversation's existing
permissions. See [memory](https://github.com/Volpestyle/clankie/blob/main/docs/memory.md).

## Models, skills, and tools

A model reasons, a tool acts, and a skill explains how to approach a task.
Choosing a model installs no browser, signs in to no account, and gives no
Discord room a shell. Chat, images, video, and voice are configured separately;
hosted availability is listed on [clankie.bot](https://clankie.bot).

## A team around him

**Work stays where you track it.** Clankie and his workers share one
Linear-shaped tracker. It uses your connected Linear account, or durable local
storage without one; `clankie doctor` shows which.

**Herdr holds the agents.** Workers run in their real terminals, which you can
watch and type into. Clankie hires and messages Claude Code, Codex, Pi, OpenCode,
and Grok Build through each harness's own channel, never by typing into the
pane, and reports when delivery is uncertain. Agents on other machines join
through a fleet link. In Machines, the owner chooses portal, workers, shell or
screen access. Ordinary self-hosted limits are service preferences. On an installed
Mac, the owner can prepare an OS-bounded launch with a private home and approved
workspaces; the running service reports verified enforcement. A new launch is
needed to restore full access. Live activation remains owner-held. The [adapter guide](https://github.com/Volpestyle/clankie/blob/main/packages/agent-hosts/README.md#tool-flow-and-current-support)
lists support and limits.

Registered local owner checkouts follow main automatically while the service
runs, preserving local edits and reporting anything that blocks advancement.
New hires fetch main and advance a clean, unused checkout that is merely behind;
dirty or divergent work stays protected. Saved sessions keep their directory.

Agents can also message Clankie and each other (`message_clankie`,
`message_peer`). Those messages are agent output and carry no owner authority;
`/fleet` can switch peer messages off. A busy-looking agent or a claim of "done"
is something to check, not proof the work is finished.

In the app, agents appear in Messages, as figures in Commons, and as live panes
in Terminal. In the console, `/chats`, `/agents`, `/rooms`, `/history`, and
`/sessions` open each kind of thread
([vocabulary](https://github.com/Volpestyle/clankie/blob/main/docs/product-vocabulary.md),
[console](/console/)).

A joined screen can provide Clankie's computer body, including for a hosted
Clankie. The owner confirms each session locally and chooses observation or
input. A visible pet offers Stop; access reduction and loss of consent stop
queued input. The host supports bounded native input with exact receipts. Observer
acknowledgments cannot prove queue drain, so Stop retains a post-input lease. Real Mac and Windows driving checks remain open.

## Where the service and data live

Locally, the service keeps running after the console closes, as long as the Mac
stays awake and online ([`clankie awake on`](/cli/#awake) helps). Hosted, closing
a client leaves his work running within the plan's limits.

The host keeps service state and credentials: Keychain on macOS, a private file
store on Linux. Connected GitHub, Linear, and Google accounts are stored there
too, and can be reviewed or disconnected from the app or console. Model requests
go to whichever provider you chose, so running locally does not make every model
call local. See [credentials](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md).

The app reaches the host through the public gateway, which relays encrypted
exchanges it cannot read (it sees only routing metadata, sizes, and timing). A
self-hosted Mac can also offer a direct route with no account. Either way the
host issues pairings and enforces every device's grants
([network](/network/), [privacy](https://clankie.bot/privacy/)).

An owner can open a support window of up to 72 hours. Read access shows history
and state but cannot send, change settings, or see terminals; revoking it ends
access immediately ([`clankie support`](/cli/)).

## Go deeper

The [architecture](https://github.com/Volpestyle/clankie/blob/main/docs/architecture.md)
is the canonical system diagram and request-flow reference, and the
[reference shelf](/reference/) leads to the CLI, API, and subsystem guides.
[Decision records](https://github.com/Volpestyle/clankie/tree/main/docs/adr)
explain how the design got here.
