# ADR 0363: Agents in Rex take a paste, under the owner's switch

Status: Proposed, 2026-11-05, for [#963](https://github.com/Volpestyle/clankie/issues/963).
Amends [ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md) and
[ADR 0207](0207-work-records-and-native-agent-delivery.md) for Rex only. Proven
against a fake `rex` only; a real-Rex proof is owed.

## Context

Rex (Superlogical, beta, macOS) is a terminal server whose sessions, windows
and blocks outlive its app. Agents the owner runs there report their state
through the Program Status Protocol (OSC 7501): idle, working, done, blocked or
error. Clankie should hold them as he holds Herdr panes and the Herdr desktop
app's terminals: list, read, message, press keys, close.

Rex has no channel into an agent other than its terminal. Every way in is
input: `rex send` types bytes, `rex send-key` presses keys, and the `block.event`
API delivers a `paste`. ADR 0207 rules out falling back to terminal typing for
automated messages, and the Herdr desktop app's agents stay read-only for that
reason. Rex also has no authentication of its own yet: its local Unix socket
admits the owner's account, and it can also listen on HTTP or Tailscale. Its
beta API changes between releases, and its CLI starts a missing local server
unless told not to.

## Decision

- **Rex is reached through the `rex` CLI on the Mac, behind service ops.** The
  `rex_list`, `rex_read`, `rex_send`, `rex_keys` and `rex_close` operator ops
  run `rex` in Clankie's service (`apps/clankie/src/captain/rex.ts`), so the
  relay's grants and stamps apply as they do to Herdr's ops, and
  `createRexSessionSource` puts them behind the session seam.
- **Local only, nothing started, nothing raised.** Every call passes
  `--autostart=false` and names this Mac's own socket with `-S`: Rex's runtime
  directory's `server.sock` (`~/Library/Application Support/rex/server.sock`),
  or a `REX_SERVER` that is a Unix socket. A Rex config or runtime directory in
  Clankie's environment is not passed to `rex`, so neither picks another server. A
  `REX_SERVER` that is not a Unix socket is refused before Rex runs, whatever
  else it names: a Tailscale host, a host label or plain HTTP. Clankie never
  runs, splits, focuses or zooms a Rex block; `open` answers `unavailable`.
- **The API revision gates every call.** `server.version` must include the
  revision the adapter was written for (7). Any other revision, or a server with
  none, lists nothing and says why; the other session sources list as before.
- **Reads follow ADR 0307.** Only a block whose program reports a status, with a
  process in front that isn't a shell. Claude Code and Codex are read from their
  own transcript, never the screen; other agents are read only for what they
  showed since their first read. Either the program's reported `app` or the name
  of the process in front naming Claude Code or Codex is enough to keep the screen
  unread, and the two naming different harnesses reads nothing.
- **A message is one paste and Enter, never typing.** `rex_send` delivers the
  whole message as one `block.event` paste, so line breaks don't become Enters,
  then presses Enter. It refuses an agent that waits on a prompt (text would
  answer it) or reported an error, and a block with no live agent. A failed paste
  sends nothing more: no `rex send`, no keystrokes, no Enter. The result is
  `queued` when the agent was working, `delivered` once Rex's event stream (or one
  last status check) shows it working, and otherwise `unconfirmed`. This is the
  amendment to ADR 0207: a paste addressed to one block, through Rex's own API,
  is how Rex's agents take a message. It is not typing into the owner's window.
- **A connected app needs the owner's prompts-and-keys switch.** A message or a
  key can answer a prompt, so `rex_send` and `rex_keys` from a connector device
  pass the same per-app switch as `key_press` ([ADR 0323](0323-connected-apps-press-keys-in-agents-terminals.md)). The service
  checks the app's connector record and the switch before the call, again before
  every key, and again before the paste and before the Enter that follows it; the
  first failure presses nothing more. The relay stamps the device, refuses a
  caller-named one, and admits these ops under `terminalObserve`, as it does
  `key_press`. The owner's own devices need `terminalControl`, and `rex_close`
  needs the steer grant.
- **Close refuses every block for now.** Clankie hires nothing into Rex yet, so
  every block is the owner's, and a block's label is the owner's to set, so it
  proves nothing. `rex_close` refuses each one without asking Rex. A later slice,
  hiring into Rex, closes only a block it finds in Clankie's own hire record, and
  only once its agent isn't mid-turn or at a prompt.

## Consequences

- Leads and apps see the owner's Rex agents beside Herdr's, read them under the
  same scope, and can message them once the owner turns the app on.
- The adapter's JSON shapes for `block ls`, the `program_status` and `process`
  block methods are not in Rex's public docs. Each field name appears in the Rex
  CLI's JSON tags, but the nesting is a guess. A real Rex install must confirm
  them, the paste semantics and the event stream before this is accepted.
- Hiring into Rex, and closing those hires, is a later change.
