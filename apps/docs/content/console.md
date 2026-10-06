# The console

The console is a full conversation with Clankie in your terminal. Ask for help,
work on a project, configure his connections, or inspect an agent's progress.
For the first installation, follow [Get started](/get-started/); for models,
skills, and worker setup, use [Customize Clankie](/diy/).

In local mode, `clankie` starts the service if needed and opens the console; in
hosted mode it connects to your remote Clankie through the paired-device
transport, with a [smaller command set](/cli/#local-and-hosted-connection-modes).
First launch asks which. `/` opens command suggestions, `Ctrl+/` the workbench.
Any terminal works; Herdr is optional. This page describes the local console;
the [CLI](/cli/) is the headless equivalent.

## Live agents

While agents are working, a dock under the editor counts them and shows up to
three that want attention: blocked or disconnected first, then working, then
done. Agents on another machine are labeled with it. Expand the dock or open
`Ctrl+G` (see [Keys](#keys)) to pick one and open its conversation.

An agent's conversation shows its newest 20 turns and then follows live
(`clankie conversations show ID` reads older ones). A bar above the transcript
names who you are talking to, and the bar and input border take the harness
color: yellow for Claude, blue for others. Messages go through the same native
delivery as `/agents`, and drafts stay with their conversations. Escape returns
to where you were without stopping the worker.

When a harness holds the conversation's seat (for example `clankie claude`), the
footer names it, such as `claude seat`, in place of the model.

## Slash commands

`$` opens the skill picker, and `/skill-name task` runs a skill directly. A
command typed bare opens its menu (`/project`, `/access`, `/accounts`,
`/devices`, `/machines`, `/minecraft`, `/rivals`, `/update`), and settings
commands such as `/autonomy`, `/awake`, `/browser`, and `/routing` list each
setting with its value. With arguments, a command runs the same code as the
CLI. This table is generated from the console's command registry.

{{SLASH_COMMANDS}}

## Keys

| Key                           | What it does                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Ctrl+/`                      | Open the command workbench                                                                                                                                                                 |
| `Down` on an empty prompt     | Expand the agent dock into the whole fleet; Up/Down selects, Enter opens its conversation, Escape returns                                                                                  |
| `Ctrl+G`                      | Open the full live-agent modal; Up/Down selects, Enter opens its conversation, Escape closes                                                                                               |
| `Ctrl+Y` in an expanded agent | Focus that agent's pane in its Herdr workspace (over SSH for another machine); never starts a Herdr server                                                                                 |
| `Esc` in an expanded agent    | Return to the previous conversation; leave the worker running                                                                                                                              |
| `Ctrl+O`                      | Toggle every tool and bash block between preview and full output                                                                                                                           |
| `Ctrl+Shift+F`                | Search the transcript                                                                                                                                                                      |
| `Ctrl+Shift+V`                | Toggle the live voice-transcript overlay (same as `/vt`)                                                                                                                                   |
| `Esc`                         | Interrupt the in-flight turn; the service aborts the model turn and settles the run as cancelled. A second `Esc`, or an older service, detaches the console instead and the turn continues |
| `Ctrl+C` inside `/btw`        | Discard the side conversation and restore the main transcript                                                                                                                              |
| `Ctrl+X` inside `/btw`        | Switch between the side conversation and the main thread, keeping both                                                                                                                     |
| `!` on empty input            | Open the inline shell in the conversation's directory                                                                                                                                      |
| `$`                           | Open the skill picker                                                                                                                                                                      |
| Click a tool or bash block    | Toggle just that block                                                                                                                                                                     |
| Click a herdr pane id         | Jump the session to that pane (same as `/jump`)                                                                                                                                            |
| Mouse wheel, drag             | Scroll the transcript, select text                                                                                                                                                         |

{{TUI_README_WORKSPACES}}

{{TUI_README_OPERATOR_BEHAVIOR}}

`/discord` connects a server with a Participant or Admin role, a fleet toggle,
and a tracking level, and requests exactly that role's permissions. Setup marks
proven missing permissions **needs** and unknown ones **not checked**. Admin
controls its dedicated server except deleting it or transferring ownership. Raw
IDs and machine grants live under Advanced. Opening or saving setup never posts.

## Account connections

`/connect accounts` (or `/connections` → Accounts) shows each connected
service's identity and permissions. Gmail and Calendar are read-only; Drive
uses Google's file picker, and Clankie's tools only read the files you pick.
Disconnecting any Google service disconnects all three and reports whether the
provider revoked access. See [account setup](/cli/#account-setup).

## Follow Linear

Connecting Linear and following its activity are separate. `/connect linear`
does both; bare `/linear` opens **Follow Linear** with its **Wake rules** and
destination chats. Project activity goes to its configured lead chat, otherwise
`global-default` with the project named. Notifications become read after the target
chat confirms its wake. Default rules wake for signed
comments and mentions from the owner emails in those rules, assignments or
delegations to Clankie, and reactions on his comments. Other activity is visible
without waking him. He can adjust the rules himself (`linear_wake`,
`clankie linear wake set`). The [Linear reference](/cli/#linear-status-linear-follow-on-off)
covers webhooks, status, and recovery.

## Headless

Scripts use the [CLI](/cli/): most commands print JSON and exit 0 or 1, while
pairing, device listing, and credential rotation print for people unless you
pass `--json`. Secrets are only entered interactively (`/auth`, `/discord`,
`/connect`, `/voice`) so tokens never become flags.
