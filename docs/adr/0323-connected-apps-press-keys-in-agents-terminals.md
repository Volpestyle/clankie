# ADR 0323: Connected apps press keys in agents' terminals

Status: Accepted, 2026-11-01, on James's ask: "arrow keys and everything you
should be able to manipulate tui as needed". Amends
[ADR 0303](0303-connected-apps-answer-agents-prompts.md) and
[ADR 0319](0319-hires-run-in-the-desktop-apps-terminals.md); keeps
[ADR 0207](0207-work-records-and-native-agent-delivery.md) for messages.

## Context

`answer_prompt` lets a connected app answer a prompt only while Herdr reports
the pane `blocked`, only while the text the app expects is still on screen, and
only once for each screen. That covers permission prompts and menus. It doesn't
cover the rest of driving a native agent's interface: stopping a turn with
`esc` or `ctrl+c`, leaving a screen, moving through a picker that never reports
`blocked`, or switching Claude Code's mode with `shift+tab`. Those still needed
James at the keyboard. Hires in the Herdr desktop app couldn't take any keys,
because the desktop core runner sent none.

## Decision

The connector gains `press_keys`: up to 24 named keys pressed in order in an
agent's terminal, whatever the agent is doing.

- **Named keys only, never text.** A key is `enter`, `esc`, `tab`, `space`,
  `backspace`, `delete`, an arrow, `home`, `end`, `pageup`, `pagedown`, a
  letter or a digit, optionally after `ctrl+`, `alt+` or `shift+`. The protocol
  (`KeyPressSchema`) and the connector refuse anything else. Messages still go
  through the persona thread (`message_agent`), so this is never a way to
  deliver a brief.
- **The same switch as answering prompts.** A key can approve a prompt as
  surely as `answer_prompt` can, so `clankie connector prompts on APP` turns on
  both and `off` takes both back. An app that hasn't been turned on presses
  nothing. One switch keeps the settings few, and the trust it grants is the
  same.
- **Checked before every key.** The pane and its machine connection are bound
  once. Before each key the agent must still be in that pane, no owner ask may
  hold its question, Clankie must not be only watching, and the app's switch
  must still be on. A key press that stops part way says how far it got, and a
  failed send reads as uncertain.
- **Signed and recorded.** The relay stamps the connector device on the
  `key_press` op and refuses a caller-named one (`400 key_press_app_is_stamped`).
  The service takes the stamp only on the relay's captain lane, names the app
  from that device's record, and leaves a note on the board saying which keys
  went to which agent.
- **Every machine, and the desktop app.** Herdr panes take keys through `herdr
pane send-keys`, over ssh for a linked PC. Herdr 0.9.3 names no `home`, `end`,
  `pageup`, `pagedown` or `delete` and refuses them as `invalid_key`, so those
  go in as the bytes an xterm sends (`ESC [5~`, `ESC [1;5H` with a modifier)
  through `herdr pane send-text`, which passes them as they are. A desktop-app hire takes them
  through the core's `terminal.keys`, which encodes each key for the program's
  keyboard modes, and only in a terminal Clankie started. A desktop-app hire
  takes no text, so `answer_prompt` there takes named keys only.

## Consequences

- An app that is on can interrupt a working agent, and can approve whatever a
  prompt offers. James turns it on only for apps he trusts that far, and the
  tool's description tells the app to leave anything that spends money, touches
  accounts or can't be undone to him.
- A desktop-app hire's Stop presses `esc` the same way a Herdr pane's does.
