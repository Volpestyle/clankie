# The console

The console is a full conversation with Clankie in your terminal. Ask for help,
work on a project, configure his connections, or inspect an agent's progress.
For the first installation, follow [Get started](/get-started/); for models,
skills, and worker setup, use [Customize Clankie](/diy/).

In local mode, `clankie` starts the service if needed and opens the console.
In hosted mode it connects to your existing remote Clankie. First launch asks
which mode you want. The transcript shows messages and tool work above the
editor; `/` opens command suggestions and `Ctrl+/` opens the workbench.
An ordinary terminal works; Herdr is optional for viewing the built-in workers.

The local console uses the service's [HTTP API](/api/). Hosted mode uses the
paired-device transport and supports a smaller command set; see
[connection modes](/cli/#local-and-hosted-connection-modes). The tables below
describe the local console. The [CLI](/cli/) is the headless configuration and
control reference, including its output formats and exceptions.

## Slash commands

Type `/` for the typeahead, `Ctrl+/` for the workbench, or `$` at a token boundary for the skill picker. `/skill-name task` invokes a loaded skill directly. This table is generated from the console's own command registry.

{{SLASH_COMMANDS}}

## Keys

| Key                        | What it does                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Ctrl+/`                   | Open the command workbench                                                                                                                                                                 |
| `Ctrl+O`                   | Toggle every tool and bash block between preview and full output                                                                                                                           |
| `Ctrl+Shift+F`             | Search the transcript                                                                                                                                                                      |
| `Ctrl+Shift+V`             | Toggle the live voice-transcript overlay (same as `/vt`)                                                                                                                                   |
| `Esc`                      | Interrupt the in-flight turn; the service aborts the model turn and settles the run as cancelled. A second `Esc`, or an older service, detaches the console instead and the turn continues |
| `Ctrl+C` inside `/btw`     | Discard the side conversation and restore the main transcript                                                                                                                              |
| `Ctrl+X` inside `/btw`     | Switch between the side conversation and the main thread, keeping both                                                                                                                     |
| `!` on empty input         | Open the inline shell in the conversation's directory                                                                                                                                      |
| `$`                        | Open the skill picker                                                                                                                                                                      |
| Click a tool or bash block | Toggle just that block                                                                                                                                                                     |
| Click a herdr pane id      | Jump the session to that pane (same as `/jump`)                                                                                                                                            |
| Mouse wheel, drag          | Scroll the transcript, select text                                                                                                                                                         |

{{TUI_README_WORKSPACES}}

{{TUI_README_OPERATOR_BEHAVIOR}}

## Follow Linear

Connecting an account and following its notifications are separate choices.
Use `/connect linear` for the account and the follow setup. Bare `/linear` opens
**Follow Linear**, including **Wake rules**. Defaults wake only for configured
owner humans and exclude subscription notices; unknown authors stay quiet. The
[Linear reference](/cli/#linear-status-linear-follow-on-off) owns webhook
configuration, enabling following, status, and recovery.

## Headless

Use headless commands for scripts: `clankie status`, `clankie doctor`, `clankie model set`, and `clankie persona set` print JSON and exit 0 or 1. Pairing, device listing and operator credential rotation default to human-readable output; pass `--json`, for example `clankie pair --json`. Other output exceptions are listed in the CLI reference. The full contract, with every flag and payload, is the [CLI reference](/cli/). Secret entry stays interactive — `/auth`, `/discord`, `/connect`, `/voice` — because tokens never become flags.
