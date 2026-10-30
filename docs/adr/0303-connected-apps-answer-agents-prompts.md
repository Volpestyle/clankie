# ADR 0303: Connected apps answer the prompts open in agents' panes

Status: Accepted by James, 2026-10-30. Amends
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md); keeps
[ADR 0207](0207-work-records-and-native-agent-delivery.md) for messages.

## Context

Native agents stop on their own questions: a permission prompt, a numbered
menu, a "Type something" box. Herdr marks such a pane `blocked`. A connected
app could read that screen through `read_agent`, but ADR 0301 kept the
connector from ever typing into a terminal, so every one of those prompts
waited for James at the machine. James asked to "make it easy for you to answer
the native questions that pop up in the TUI."

## Decision

The connector gains one tool, `answer_prompt`, and nothing wider.

- **Only an open prompt.** `answer_prompt` takes the agent, a short piece of
  the prompt's text the app expects on screen (`expect`), and up to twelve
  steps, each a named key (`enter`, `esc`, `tab`, the arrows, `space`,
  `backspace`) or plain text without control characters (at most 2,000
  characters). The service sends them only while Herdr reports the pane
  `blocked`, only while `expect` is still on the visible screen (compared with
  whitespace squashed), and only once for the same screen of the same pane.
  Those checks, the owner's switch and the owner-ask check run again before
  every step, not only the first, and the pane and its machine connection are
  bound once for the whole answer (amended 2026-10-30 after cladot's review).
  Messages still go through the persona thread (`message_agent`); this tool is
  never a way to deliver an automated brief (ADR 0207).
- **Off until the owner turns it on, per app.** `clankie connector prompts on
APP` lets one connected app answer; `off` takes it back, and revoking the
  device ends it. The list lives in the service's state root
  (`connector-prompt-answers.json`, mode 0600) and holds device ids only.
- **The owner's questions stay the owner's.** When Clankie has escalated a
  hired worker's native question to the owner's ask store, the tool refuses
  that pane.
- **Signed and recorded.** The relay stamps the authenticated connector
  device on the `prompt_answer` op and refuses a caller-named one (`400
prompt_answer_app_is_stamped`); the service accepts the stamp only from the
  relay's captain lane and names the app from that device's record. Each
  answer leaves a note on the shared board in that app's name, saying which
  keys or text went to which agent.
- **The app judges, the tool says where the line is.** A screen prompt doesn't
  say reliably whether it spends money, touches an account or can't be undone,
  so the service can't gate those. The tool description and the connector's
  instructions tell the app to leave such prompts to the owner.
- **Through session sources.** Sources gain an optional `answer`. Herdr's
  dispatches the `prompt_answer` op, which presses keys with `herdr pane
send-keys` and types with `herdr pane send-text` on the pane's own machine,
  over ssh for a linked PC. A source without it refuses.

## Consequences

- An app that is on can approve whatever a native prompt offers, including
  "always allow" choices. James turns it on only for apps he trusts that far.
- A prompt that shows the same text twice (for example, the same menu again
  after the agent moved on) is refused as already answered; the app reads the
  screen and the owner answers that one.
- Uncertain sends (a key reached the pane, the next didn't) come back as
  `uncertain` so the app reads the screen before anything else.
- An answer stops part way when, between steps, the prompt leaves the screen,
  the agent stops waiting, its terminal moves to another pane, the owner turns
  answering off, or the linked PC's connection changes (its runner refuses every
  later call rather than reach the new endpoint). The reply and the note on the
  board say which steps went in, so `expect` should be text that stays on
  screen until the answer is in, such as the question.
