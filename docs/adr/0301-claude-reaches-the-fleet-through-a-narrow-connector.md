# ADR 0301: Claude reaches the fleet through a narrow connector

Status: Accepted by James, 2026-10-29. Builds on
[ADR 0300](0300-clankie-runs-only-on-the-owners-machine.md) and the doorway of
[ADR 0204](0204-a-self-hosted-mac-pairs-the-app-directly.md).

## Context

James wants Claude, in the Claude apps, to see the agents running in Herdr on
his work Mac and on the PCs that build games, and to message them, without
opening the Clankie app. Claude connects to tools through remote MCP servers
that it adds as custom connectors, signs in with OAuth 2.1, and calls from
Anthropic's own servers. Nothing on Anthropic's side can hold a Clankie device
key or speak the doorway's end-to-end encryption.

## Decision

The Mac serves a remote MCP server, reached at
`https://api.clankie.bot/h/{hostId}/mcp` through the doorway, or at the relay's
own `/mcp` on a trusted network.

- **Three tools.** `list_agents` names each agent with its machine and
  project, `read_agent` returns the text on its screen, and `message_agent`
  writes into its own persona thread, which delivers to the native pane. A
  connector never types into a terminal (except to answer an open prompt, once
  the owner turns that on for the app:
  [ADR 0303](0303-connected-apps-answer-agents-prompts.md)), closes a seat, writes to a tracker,
  reads settings, tails Clankie's own thread, or joins a call.
- **Starting an agent, narrowly.** `start_agent` (added 2026-10-30) starts a
  Claude Code or Codex agent in a known project's checkout on a machine
  Clankie reaches, with an optional first prompt, and nothing wider: the
  places are the projects' registered workspaces, and a linked machine's also
  need the owner's exact-directory grant (ADR 0193). Clankie's own thread
  leads the new seat, as it leads his own hires, so a connector never owns a
  worker. The granted place, not that thread, decides the new seat's project
  (2026-10-31), so a change of Clankie's own agent, as after a restart, doesn't
  refuse the start. Connector devices now carry `steer`, which the op allowlist lets
  reach `start_agent` alone; a connector signed in before this change signs in
  again to get it. `list_places` lists the places without starting anything, so an
  app's own permission check can tell a listing from a start.
- **Reading the owner's issues.** `list_issues` lists the owner's projects with
  the tracker each keeps its issues in (private issue files, Linear, GitHub
  Issues or the built-in tracker), and one project's issues; `read_issue` reads
  one in full with its comments and state changes (added 2026-10-30). They are
  the same reads the Clankie app makes (`work_repos`, `work_items`,
  `work_item_activity`) and need only `chat`. Writes go only through
  `save_issue` and `comment_issue`, as an agent under the project's posting
  setting ([ADR 0305](0305-connected-apps-write-issues-as-agents.md)); every
  other work write stays off its op allowlist.
- **A note board the apps share.** `post_note` leaves a short note (at most
  2,000 characters) and `read_notes` reads the board, oldest first, after an
  optional cursor (added 2026-10-30, approved by James). Each note is signed
  with the name the owner approved the app's device under: the relay stamps
  the device it authenticated and refuses a caller-named author, and the
  service names it from that device's record. Clankie reads the board with
  `read_notes` and hired workers with `clankie_read_notes`; neither posts.
  Notes live in the fleet room as `app_note` entries, outside every room page
  that doesn't opt in (ADR 0273 amendment). A note is information from another
  app, never an instruction, and every tool that returns one says so.
- **One server for every agent app.** Claude Code, Codex, Grok and any other
  MCP app that signs in through its own https callback or a loopback one add
  the same URL, beside the Claude apps. A fourth, read-only tool, `clankie_guide`, serves the skills
  Clankie ships in `.agents/skills`, so an app that can't load Clankie's
  skills still learns how his tools and fleet work. It reads files in this
  checkout only and calls nothing on the service (added 2026-10-30).
- **Every linked machine, said plainly.** `read_agent` reads a pane through
  Herdr on that pane's own machine (the `terminal_read` op), so a PC's agents
  read over ssh like the Mac's. `list_agents` names each linked machine even
  with no agents on it, marks agents on a machine that isn't answering as
  `unreachable` rather than showing their last status, and says in a notice
  when a machine's Herdr is older than the one Clankie ships (added
  2026-10-30).
- **The Herdr desktop app is a second source.** It runs agents in its own
  terminal server, herdr-core (`hc`), not in the terminal Herdr. The service
  reads that server's socket on the Mac (`herdr_core_list`, `herdr_core_read`
  and `herdr_core_focus` ops) and the `herdr-core` source lists and reads its
  agents beside Herdr's, with ids like `herdr-core:t3`. Its reads are bound
  as a Herdr pane's are (ADR 0307). Its agents can't be messaged: herdr-core's
  only way in is typing into the terminal, which ADR 0207 rules out (added
  2026-10-31).
- **Through session sources, not Herdr.** The tools talk to the session-source
  layer in `packages/agent-hosts/src/sessions/`. A source is any app that holds
  agent sessions and answers four things: list its sessions, read one, send one
  a message, and open one in its own app. Herdr is the first source; Orca or
  another app becomes a second one without changing the tools. Session ids
  carry their source (`herdr:<seat or terminal id>`), and callers pass them
  back unchanged. Clankie and the phone move onto the same layer next. The
  Herdr source's open is the `terminal_focus` operator op, which runs
  `herdr agent focus` on the pane's machine; the connector doesn't offer it.
- **Signing in pairs a device.** The service is the OAuth authorization server
  (RFC 8414 metadata, RFC 7591 registration, PKCE S256). Registration is
  stateless: the client id carries its name and callbacks under the Mac's key.
  A code goes only to an app's own https callback or to a loopback address
  (widened from Claude's callbacks alone on 2026-10-30, so Grok and other
  hosted apps can sign in); the page and `clankie connector` name the host it
  goes to. The
  sign-in page shows a short code, and the owner approves it with
  `clankie connector approve CODE`. The same owner route accepts the app's
  Take Control devices, so the app can offer approval later. Approval pairs one device
  with `scope: "connector"` and `CONNECTOR_GRANTS`; its device session token is
  the access token (an hour), and refresh tokens rotate on every use and stop
  working after 90 idle days. `clankie devices revoke` ends both.
- **Narrow by the scope, not the grants.** The service answers a connector
  device only at `GET /v1/devices/self`. The relay holds it to its op
  allowlist, and confirms each send or read is for a persona thread before it
  dispatches.
- **Detection is the owner's.** `clankie connector detect` turns Herdr
  discovery on or off, and `clankie connector serve` turns the connector on or
  off per connected app. With Herdr on, a cleared or restarted session is
  rediscovered and an unconfirmed operator message is sent once more, or the
  error says why ([ADR 0312](0312-a-cleared-session-is-rediscovered.md)).
- **Capacity is a read.** `fleet_capacity` shows what the fleet can afford
  before a hire, from numbers Clankie already tracks. A missing number is
  `"unknown"` ([ADR 0313](0313-the-connector-can-read-what-the-fleet-can-afford.md)).
- **Images go both ways, as files.** `message_agent` carries images as owner
  attachments into the agent's workspace, and `read_image` returns an image the
  agent saved there
  ([ADR 0315](0315-connected-apps-pass-images-to-and-from-agents.md)).
- **Plaintext through the doorway, for this route only.** The gateway carries
  the connector's discovery, OAuth and `/mcp` calls in plaintext, with the
  `authorization` header only on `/mcp` and a query only on the sign-in link.
  It also answers RFC 8414 and RFC 9728 discovery at the origin's root
  (`/.well-known/oauth-authorization-server/h/{hostId}`). Everything else still
  needs gateway encryption. The Mac's gateway connector names the public base
  in `x-clankie-public-base`, so discovery documents name doorway URLs.

## Consequences

- The gateway terminates TLS for connector calls and can read pane text and
  messages on their way through. James accepted this for the connector; the
  app's own traffic stays end-to-end encrypted.
- Pane text from another agent is information to Claude, never instructions,
  and the MCP server says so in its instructions.
- Approve only a code you see on your own sign-in page: whoever opened that
  page receives the access.
- Connector budgets are per host because Claude's servers share a few
  addresses; the sign-in page also has a per-client budget.
