# ADR 0082: Clankie holds the browser

Status: accepted (James, 2026-08-08). Amends
ADR 0027, which rejected giving the
captain web reach. ADR 0027 remains authoritative for the MCP registry, the
risk-class vocabulary, and the worker projection; only the captain's own
capability changes here.

## Context

Clankie has one centralized tool bank in `apps/clankie/src/captain/tools.ts`.
Every captain lane uses it, and Discord voice reaches it through `ask_clankie`
([ADR 0057](0057-realtime-voice-with-captain-handoff.md)). Browser tools belong
in that bank so a lookup uses the same governed capability in every room.

ADR 0027 declined this on the grounds that "the tool-less captain is the
architecture's core safety property; execution belongs in governed workers."
That framing bundled two unlike things under one word. A captain with `bash`
and `write_file` can edit the doctrine it is judged against and the tests that
gate it — that is the property worth keeping. A captain that can read a web
page cannot. Web reach is swept along by a rule aimed at something else.

Workers remain coding agents scoped to worktrees and diffs. Clankie is the
general-purpose seat, so conversational browsing does not require a worker.

Options weighed:

1. Delegate a research worker per lookup. Rejected: the cost is wrong for
   conversation and the captain cannot answer directly.
2. Register a search MCP server for the captain only. Rejected as insufficient
   alone: it answers search but not the authenticated, JavaScript-heavy, or
   multi-step pages that a real lookup reaches.
3. Mount `agent-browser` as a framework MCP connection on the captain. Rejected
   twice over: `defineMcpClientConnection` requires a URL speaking Streamable
   HTTP or SSE and `agent-browser mcp` is stdio-only, and even bridged it
   would put process ownership in the captain and replace doctrine projection
   with a static allow/block filter.
4. Give the captain a service-owned `agent-browser` with its full action set.
   Accepted.

## Decision

**Browser reach joins the bank.** The service reads the live MCP catalog and
registers every `agent-browser` tool with pi. A small everyday set starts active;
`browser_tool_search` activates uncommon tools additively when a task needs them.
The host follows MCP pagination, so the catalog is complete rather than only
the first page. If the host is unavailable, the captain receives one truthful
`browser_unavailable` tool.

**Browser access does not grant system tools.** [ADR 0095](0095-discord-system-actors.md)
limits pi's shell and filesystem tools to the operator and configured system
actors. Browser projection follows its own catalog and risk classes.

**`agent-browser` is Clankie's browser, not a worker's tool.** The Clankie
service hosts it as a stdio MCP server (`agent-browser mcp --tools all`) and the
captain reaches it through the same in-process capability bank. Browser calls
are serialized in the host because every room shares one browser state. Pi also
marks each browser definition sequential, preserving order within one tool
batch.

**The profile is his, and it persists.** A browser that forgets every session
turns each lookup behind a login into a password request, which is the
opposite of the capability being added. The profile therefore lives in the
service's private state root and is reused through `AGENT_BROWSER_PROFILE`. It
is Clankie's own profile, never the operator's browser.

Unlike the Codex projection, the captain's browser carries **the full action
set**. The read-only policy that gates the Codex shell (`navigate`, `snapshot`,
`scroll`, `wait`, `read`, `get`) is a worker-shaped restriction; a
general-purpose seat that can read a page but never fill a form is not doing
the job asked of it.

**The subprocess is hardened, not sandboxed.** It receives an allowlisted
environment with a dedicated `HOME`, `TMPDIR`, socket directory, and profile;
Clankie tokens, the SSH agent, and unrelated service credentials do not cross
the spawn boundary. Raw `extraArgs` are refused so a model cannot replace those
paths or inject arbitrary CLI flags. This remains the same macOS user and
kernel, so it is not a filesystem or network security boundary. Strong
containment means moving the complete MCP, daemon, and Chrome process tree into
a dedicated VM or remote browser broker with no host mounts or credentials.

![ADR 0082: Clankie holds the browser](../diagrams/0082-clankie-holds-the-browser.jpg)

## Consequences

- Every lane gains lookup at conversational cost. A question asked in voice is
  answered on the same path as one asked in the TUI, which is what one
  character with one bank is always supposed to mean.
- **A full-action browser sits behind `ask_clankie`, so untrusted room text can
  reach it.** Content boundaries label page output but do not create a security
  boundary. Authenticated profiles therefore carry materially more risk than
  anonymous browsing until the process tree moves behind an OS boundary.
- Dynamic activation keeps 150-plus schemas out of the initial prompt without
  reducing the registered capability set. Providers with native deferred tools
  use Pi's load point; other providers receive the additive active set.
- Tool text is bounded to Pi's 50KB/2,000-line limits. MCP error results become
  failed Pi tool results instead of successful error-shaped content.
- Workers keep their own coding-oriented research paths.

## Current state

The service owns the stdio MCP host, registers the paginated live catalog in Pi,
and starts with open/read/snapshot/click/fill/screenshot/current-URL plus the
tool search loader. Browser calls are globally serialized.

`CLANKIE_BROWSER_ENABLED` **defaults on**, and only an explicit falsey value
turns it off. A missing binary degrades to a logged unavailability rather than
a boot failure.

The free-play mind has no direct browser route. In a voice room, browser
questions reach the captain through `ask_clankie`; direct play-loop
interjections remain inside the loop.
