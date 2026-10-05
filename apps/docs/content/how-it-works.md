# How Clankie works

Clankie lives in a persistent service. The app, terminal console, and configured
Discord and voice connections are ways to reach him. His machine can be one you
maintain or a private hosted machine; the service owns his conversations,
memory, tools, and access in either case.

You can use him without knowing the pieces below. They become useful when you
want to customize him, connect a team, or understand where your work goes.

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
    <div class="dnode"><strong>Helper agents</strong><span>native harnesses · optional peer coordination</span></div>
    <div class="dnode"><strong>Optional services</strong><span>accounts · browser · media · play</span></div>
  </div>
</div>

## One identity, separate conversations

Clankie's character belongs to the service. A chat in the app, a project in the
console, and a Discord room do not each create a new personality. They do have
separate conversation histories and permissions. Sharing an identity does not
mean every room receives everything said elsewhere.

His built-in agent uses [pi](https://pi.dev) for models, sessions, tools, skills,
and compaction. Clankie adds durable identity, memory, the connections around
him, and the authority each caller carries. Optional
[Claude](https://github.com/Volpestyle/clankie/blob/main/integrations/claude-plugin/README.md)
and [Codex operator seats](https://github.com/Volpestyle/clankie/blob/main/integrations/codex-plugin/README.md)
`clankie claude` and `clankie codex`, along with `clankie opencode`,
use the same service through their native harnesses. All three support
`--resume`, `--conversation ID`, `--dry-run`, and `--plugin-dir PATH`.
Numbered Claude commands use the owner’s shell account command; `clankie codex2`
selects the registered Codex account labelled `codex2`. Their setup, hook trust,
delivery, and continuation limits are documented separately.
Each fresh native launch gets its own workspace chat, including simultaneous
launches in the same directory. Resume keeps that chat; an explicit conversation
ID selects an existing one. Transcripts and wake channels follow the selected chat.

`clankie grok` provides another operator seat on macOS with Grok Build 1.0.46
and an existing sign-in. Its visible native session carries the service persona,
memory, operator tools and selected skill paths through leader IPC/ACP.
`--dry-run` reviews the launch; `--conversation ID` selects a chat and `--resume`
retains the original profile/session/chat after a confirmed exit. It does not
accept `--plugin-dir`. Native permission prompts remain owner decisions.
The selected chat can also be a Discord room. While the seat's channel is live,
worker reports, room turns, wakes and watches reach that seat; new inputs return
to the built-in agent after it leaves. Each channel or DM remains a separate
conversation with its existing permissions. Workers report to the conversation
that hired or subsequently adopted them, as resolved by the service. Without
adoption, the actual Herdr parent receives the report through its attached
conversation or native channel. If no eligible parent exists, the default
conversation gets an explicitly tagged report and doctor/roster name the lead
pane needing a bridge. This grants no tools or room permissions.

Voice and text handoffs appear as individual threads under Clankie in the dock
and app: who asked, what he is doing, and the result. Separate handoffs can run
in parallel, with up to four active at once, and answers return to the asking
room. Claude uses restricted native children. Codex uses native children for
machine-authorized work; ambient work uses the service's Pi threads with the
room's own tools until Codex can enforce a narrower child tool set. Approval
requests still continue on the authenticated operator surface.

## History, memory, and goals

These serve different purposes:

| Store                | What it gives you                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Conversation history | The thread you return to, with messages, visible tool work, and delivered files.                                           |
| Memory               | Selected experiences and facts that can inform later conversations. Notes stay until forgotten.                            |
| Goal                 | An owner-approved objective that continues in a Pi-owned conversation with a finite token budget when autonomy is enabled. |

Closing a client does not erase those records. Memory recall is bounded and filtered
by the receiving conversation's authority; operator-private notes do not enter
social Discord recall. Goals and scheduled wakes use the existing conversation
and tool permissions. They do not create extra access. The [memory reference](https://github.com/Volpestyle/clankie/blob/main/docs/memory.md)
and [CLI](/cli/) own memory and continuation controls.

## Models, skills, and tools

A model supplies reasoning. A tool performs an operation. A skill supplies
instructions for using tools or approaching a task. Choosing a model does not
install a browser, log in to an account, or authorize a Discord room to run a
shell.

The DIY setup lets you choose models and connect capabilities independently.
Conversation, images, video, and voice have separate configuration. Hosted
availability follows the managed service's current offering. See [Customize Clankie](/diy/)
for the practical setup and [clankie.bot](https://clankie.bot) for hosted availability.

## A team around him

**Work stays where you track it:** Linear, GitHub, or task files in the repo.
Clankie and his workers use one Linear-shaped tool surface; without a Linear
connection it uses durable local storage. `clankie doctor` reports the active
backend, and the existing `clankie work` commands keep working.
**Herdr contains the agents:** their native interactive terminals remain yours
to watch and use. Clankie sends assignments through each supported harness's
message connection, without typing into your draft. If delivery is unavailable
or uncertain, he reports that outcome.

Native local message adapters cover Claude Code, Codex, Pi, OpenCode and
Grok Build. Grok uses its interactive TUI's private leader IPC/ACP on macOS,
pinned to 1.0.46; native sign-in/permission gaps refuse without terminal input.
Prime Agent remains researched without a local hire adapter. Remote Claude and
Codex hires use the fleet link and native channels. See the [adapter guide](https://github.com/Volpestyle/clankie/blob/main/packages/agent-hosts/README.md#tool-flow-and-current-support)
for the message flow and current limits.

The app presents those agents in Messages and, where execution seats exist,
Commons and Terminal. A worker's contact can outlive its terminal session.
Live activity and a completion claim are evidence to inspect, not substitutes
for the finished result and its checks. Independent linked agents can initiate
messages to Clankie through `message_clankie`. They discover and message seats in
their own fleet through `list_fleet_seats` and `message_peer`, using the same native
delivery and receipts. Peer messages are agent output and grant no owner authority;
the owner can switch them off in `/fleet`.

For a local source-checkout service, `clankie integrate` composes approved core
and app commits, runs full checks in private worktrees and retains the tested
commit evidence before landing. Named deploy holds block landing and runtime
updates, with explicit audited owner overrides. See the [CLI reference](/cli/).

## Finding your way in the console

A local console opens the existing main conversation unless you select another
with `--chat`. `/cd` selects a project workspace; tools use the selected
conversation's directory. The TUI separates the things you can open:

- `/chats`: personal and workspace chats with Clankie.
- `/agents`: agents that are live now, and past ones that kept a thread.
- `/rooms`: shared channels and read-only Discord inspection.
- `/history`: all retained threads, including ongoing and offline ones.
- `/sessions`: saved harness execution records.

`/new` starts a fresh chat. `/btw` opens an ephemeral side question; `Ctrl+X`
switches between it and the main thread, while `Ctrl+C` discards it. The
[console reference](/console/) owns commands and keys, and
[product vocabulary](https://github.com/Volpestyle/clankie/blob/main/docs/product-vocabulary.md)
defines the TUI terms. Other clients may organize navigation differently.

## Where the service and data live

In local mode, the launcher keeps Clankie's service running after the console
closes. Your Mac must remain awake and online; [`clankie awake on`](/cli/#awake)
can keep it awake while plugged in. In hosted mode, the console and
app connect to a remote service; closing those clients leaves the remote work
running, subject to the host's lifecycle and limits.

The host stores service state and brokered credentials. macOS uses Keychain by
default; Linux deployments use the documented private file backend. Model
requests reach the configured provider or runtime, so running Clankie locally
does not automatically make every model request local. See [credentials](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md)
for the exact stores and exceptions.

The public gateway routes encrypted device exchanges to the host. The host
issues pairing offers and device grants and enforces them on requests. The
gateway cannot decrypt those device payloads; it can see routing metadata,
sizes, and timing. Accounts, model providers, and optional push delivery have
separate data flows. The [network reference](/network/) explains the transport
boundary; the [privacy notice](https://clankie.bot/privacy/) covers the product's
data handling.

A self-hosted Mac can also advertise a direct device route on a reachable
network. Direct pairing does not require a Clankie account and retains the
host's pairing and device-grant checks. See [pairing](/cli/#pair-json-timeout-sec-review-days-n-count-n)
for supported routes and recovery.

## Go deeper

The [architecture](https://github.com/Volpestyle/clankie/blob/main/docs/architecture.md)
is the canonical current system diagram and request-flow reference.
The [reference shelf](/reference/) leads to the CLI, API, and subsystem guides.
[Decision records](https://github.com/Volpestyle/clankie/tree/main/docs/adr)
explain how the design changed; older records describe older systems.
