# The console

`clankie` with no arguments starts the service if it is not already running and opens the fullscreen operator console. The chat surface is pi's own: a scrollable transcript of messages and tool executions above an editor docked to the bottom of the terminal, with Clankie's chrome around it — the banner, slash-command typeahead, guided setup flows, and the `Ctrl+/` command workbench. It runs in an ordinary terminal or inside a terminal multiplexer; Herdr is the supported fleet integration.

The console talks to one backend, the local service on `127.0.0.1:4310`, over the same [HTTP API](/api/) every other surface uses. Plain prompts go through the operator-conversation contract; the slash commands below configure, observe, and navigate. Every configuration command is also a headless [CLI](/cli/) command with JSON on stdout, so anything the console can set, an agent or script can set too.

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
| `!` on empty input         | Open the inline shell in the conversation's directory                                                                                                                                      |
| `$`                        | Open the skill picker                                                                                                                                                                      |
| Click a tool or bash block | Toggle just that block                                                                                                                                                                     |
| Click a herdr pane id      | Jump the session to that pane (same as `/jump`)                                                                                                                                            |
| Mouse wheel, drag          | Scroll the transcript, select text                                                                                                                                                         |

{{TUI_README_WORKSPACES}}

{{TUI_README_OPERATOR_BEHAVIOR}}

## Headless

Everything that is not live console chrome is also a command: `clankie status`, `clankie doctor`, `clankie model set`, `clankie persona set`, `clankie pair`, and the rest print one JSON document and exit 0 or 1. The full contract, with every flag and payload, is the [CLI reference](/cli/). Secret entry stays interactive — `/auth`, `/discord`, `/connect`, `/voice` — because tokens never become flags.
