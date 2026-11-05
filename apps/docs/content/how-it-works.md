# How Clankie works

Clankie is a persistent service on one machine of yours. Leads, workers and the
clients you read them in all connect to it. The service owns conversations,
memory, tools, and access, so closing a client loses nothing.

You can use it without knowing any of this. It helps when you want to add a lead,
connect a team, or know where your work goes.

<div class="diagram" role="img" aria-label="The app, the console, connected leads and optional Discord rooms reach Clankie's persistent service. The service stores conversations and memory and uses configured models, tools, and agent connections. Capabilities depend on the host.">
  <div class="diagram-col">
    <h4>Talk to a lead</h4>
    <div class="dnode"><strong>The app</strong><span>Sessions · Feed · World · Terminal</span></div>
    <div class="dnode"><strong>The console</strong><span>on this machine</span></div>
    <div class="dnode"><strong>Connected leads</strong><span>Claude · Codex · Grok</span></div>
    <div class="dnode"><strong>Optional rooms</strong><span>Discord text · voice</span></div>
  </div>
  <div class="diagram-col diagram-center">
    <h4>Your machine</h4>
    <div class="dnode dnode-main"><strong>Clankie's service</strong><span>conversations · memory · projects</span><span>tools · credentials · access</span></div>
    <div class="dnode"><strong>On your host</strong><span>your Mac or Linux host</span></div>
  </div>
  <div class="diagram-col">
    <h4>Its connections</h4>
    <div class="dnode"><strong>Models and tools</strong><span>chosen for the task</span></div>
    <div class="dnode"><strong>Helper agents</strong><span>native harnesses in Herdr</span></div>
    <div class="dnode"><strong>Optional services</strong><span>accounts · browser · media · play</span></div>
  </div>
</div>

## Leads

A lead is an agent you talk to directly, which hires and answers workers. Several
can share a fleet, and none outranks another; the service reports which are
active. There are three ways to be one.

**The built-in lead.** It is called Clankie and runs on [pi](https://pi.dev), which
handles models, sessions, tools, skills, and compaction. The service adds its
lasting identity, memory, connections, and the authority each caller brings. A chat
in the app, a project in the console, and a Discord room each have their own
history and permissions, but the same character. What is said in one room does not
leak into another.

**A seat.** `clankie claude`, `clankie codex`, `clankie opencode`, and
`clankie grok` open that tool with the built-in lead's persona, memory, and tools,
on a chat of their own or an existing one ([seat commands](/cli/#seat-commands)).
While a seat is open, worker reports and wakes for its chat go to it; when it
closes, pi takes over again.

**A connected app.** Claude, Claude Code, Codex, Grok and other MCP apps reach the
fleet through a narrow connector the host serves, signing in with OAuth to your own
machine ([bring your own lead](/diy/#bring-your-own-lead)). A connected lead can
be woken at its own webhook. The owner can hand the lead to these apps, which holds
the built-in lead's own turns until the owner hands it back. Message receipts let
a connected lead look up proven native handling later without sending again
([receipt evidence](https://github.com/Volpestyle/clankie/blob/main/docs/agent-message-receipts.md)).

Requests from Discord text or voice run as their own visible threads under
the built-in lead, several at once, and the answer returns to the room that asked.

## History, memory, and projects

| Store                | What it gives you                                                                    |
| -------------------- | ------------------------------------------------------------------------------------ |
| Conversation history | The thread you return to: messages, visible tool work, and delivered files.          |
| Memory               | Selected experiences and facts for later conversations, kept until forgotten.        |
| Projects             | Work you assign him; with Auto on he works its backlog unprompted, toward its focus. |

Memory recall is filtered by who is asking: private operator notes never reach
a social Discord room. Auto rounds and self-wakes use the conversation's existing
permissions. They flag ready work left unstaffed when seats and plan usage have room,
and ask him to plan ready work when the queue is empty. Automatic project updates
are on by default: noteworthy evidenced progress prompts a visual-first update,
roughly daily, and milestones can report sooner. Each project can turn progress
updates off through its settings ([round record and settings](/cli/)).
See [memory](https://github.com/Volpestyle/clankie/blob/main/docs/memory.md).

## Models, skills, and tools

A model reasons, a tool acts, and a skill explains how to approach a task.
Choosing a model installs no browser, signs in to no account, and gives no
Discord room a shell. Chat, images, video, and voice are configured separately.

<a id="a-team-around-him"></a>

## Workers and the work

**Work stays where you track it.** Clankie and his workers share one
Linear-shaped tracker. It uses the tracker you choose for all projects or one
project, such as your connected Linear account or durable local storage;
`clankie doctor` shows which. Built-in work carries evidence
bundles that someone else checks, and owner questions and run approvals reach you
as [asks](/cli/#owner-asks-conversations-questions-id-and-conversations-answer). You can [mirror a Linear project](/cli/) into
a scratch built-in store for inspection while Linear remains authoritative.

**Herdr holds the agents.** Workers run in their real terminals, which you can
watch and type into. Clankie hires and messages Claude Code, Codex, Pi, OpenCode,
and Grok Build through each harness's own channel, never by typing into the
pane, and reports when delivery is uncertain. Agents on other machines join
through an approved outbound connection. A joined install can open its own
`clankie claude` seat in the home's workspace chat; identity, tools and memory
stay with the one Clankie. It can resume or reset that folder’s lead, and that
lead, or Clankie himself at workers access, can hire Claude or Codex workers
there who report through the same joined connection. See the [join command](/cli/#join) for current limits.
Older remote workers use a fleet link. In Machines, the owner chooses portal, workers, shell or
screen access. Ordinary self-hosted limits are service preferences. On an installed
Mac, the owner can prepare an OS-bounded launch with a private home and approved
workspaces; the running service reports verified enforcement. A new launch is
needed to restore full access. Live activation remains owner-held. The [adapter guide](https://github.com/Volpestyle/clankie/blob/main/packages/agent-hosts/README.md#tool-flow-and-current-support)
lists support and limits. Supported idle hired seats can restart fresh in the
same pane after saving their handoff and work item; fleet status names any
refusal ([settings and safeguards](/cli/)).

Registered local owner checkouts follow main automatically while the service
runs, preserving local edits and reporting anything that blocks advancement.
New hires fetch main and advance a clean, unused checkout that is merely behind;
dirty or divergent work stays protected. Saved sessions keep their directory.

Agents can also message Clankie and each other (`message_clankie`,
`message_peer`). Those messages are agent output and carry no owner authority;
`/fleet` can switch peer messages off. A busy-looking agent or a claim of "done"
is something to check, not proof the work is finished.

In the app, agents appear in Sessions, as figures in the World, and as live
panes in Terminal, and the Feed holds what needs you and what finished. In the console, `/chats`, `/agents`, `/rooms`, `/history`, and
`/sessions` open each kind of thread
([vocabulary](https://github.com/Volpestyle/clankie/blob/main/docs/product-vocabulary.md),
[console](/console/)).

A joined screen can provide Clankie's computer body, including for a body
without a desktop of its own. The owner confirms each session locally and chooses observation or
input. A visible pet offers Stop; access reduction and loss of consent stop
queued input. The host supports bounded native input with exact receipts. Observer
acknowledgments cannot prove queue drain, so Stop retains a post-input lease. Real Mac and Windows driving checks remain open.

## Where the service and data live

The service keeps running after the console closes, as long as the Mac stays
awake and online; by default a Mac keeps itself awake while plugged in
([`clankie awake`](/cli/#awake)).

The host keeps service state and credentials: Keychain on macOS, a private file
store on Linux. Connected GitHub, Linear, and Google accounts are stored there
too, and can be reviewed or disconnected from the app or console. Model requests
go to whichever provider you chose, so running locally does not make every model
call local. See [credentials](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md).

The app reaches the host through the public gateway, which relays encrypted
exchanges it cannot read (it sees only routing metadata, sizes, and timing). A
self-hosted Mac can also offer the app a direct route with no account. Either way the
host issues pairings and enforces every device's grants
([network](/network/), [privacy](https://clankie.bot/privacy/)).

An owner can open a support window of up to 72 hours. Read access shows history
and state but cannot send, change settings, or see terminals; revoking it ends
access immediately ([`clankie support`](/cli/)).

For a self-hosted browser app, core and relay accept browser API calls only
from the owner's exact origin allowlist, configured with `clankie http`.
Preflight enables the browser transport; pairing and device grants still
decide access. The [self-hosted setup](/diy/#connect-the-browser-app-to-your-service)
describes the setting.

## Go deeper

The [architecture](https://github.com/Volpestyle/clankie/blob/main/docs/architecture.md)
is the canonical system diagram and request-flow reference, and the
[reference shelf](/reference/) leads to the CLI, API, and subsystem guides.
[Decision records](https://github.com/Volpestyle/clankie/tree/main/docs/adr)
explain how the design got here.
