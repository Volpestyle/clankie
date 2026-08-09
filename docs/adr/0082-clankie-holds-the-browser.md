# ADR 0082: Clankie holds the browser

Status: accepted (James, 2026-08-08). Amends
[ADR 0027](0027-mcp-worker-tool-projection.md), which rejected giving the
captain web reach. ADR 0027 remains authoritative for the MCP registry, the
risk-class vocabulary, and the worker projection; only the captain's own
capability changes here.

## Context

Clankie already has one centralized tool bank and every branch already calls
it. The bank is `apps/captain-eve/agent/tools/`; the TUI, Discord text, Slack,
and Linear are captain lanes ([ADR 0080](0080-slack-is-a-channel-not-a-second-captain.md)),
and the Discord voice model's entire tool surface is `ask_clankie`, described
to it as "the captain holds every tool and memory"
([ADR 0057](0057-realtime-voice-with-captain-handoff.md)). No branch grew its
own tools. That part of the architecture was already right.

What the bank did not hold was any way to look something up. Measured on the
owner's machine, every web path was closed at once:

| Path | State |
| --- | --- |
| Captain `web_search` / `web_fetch` | `disableTool()` per ADR 0027 |
| Claude worker native web research | `CLANKIE_CLAUDE_WEB_RESEARCH_ENABLED` unset |
| Codex worker `agent-browser` | `CLANKIE_BROWSER_ENABLED` unset, binary not installed |

So "look that up" had no answer in any lane. In a Discord voice channel the
only sanctioned route — create a mission and delegate a research worker — costs
more than the question is worth, and the fast conversational path that
ADR 0057 exists to protect is exactly where lookups arrive.

ADR 0027 declined this on the grounds that "the tool-less captain is the
architecture's core safety property; execution belongs in governed workers."
That framing bundled two unlike things under one word. A captain with `bash`
and `write_file` can edit the doctrine it is judged against and the tests that
gate it — that is the property worth keeping. A captain that can read a web
page cannot. Web reach was swept along by a rule aimed at something else.

The second premise has also moved. ADR 0027 placed browsing with workers, but
the workers are Claude and Codex — coding agents, scoped to a worktree and a
diff. Clankie is the general-purpose seat. Browsing is not a coding task, and
routing every lookup through a coding agent shapes the system around the
wrong specialty.

Options weighed:

1. Leave it, and delegate a research worker per lookup. Rejected: the cost is
   wrong for conversation, and it was already the status quo that produced a
   captain who could not answer.
2. Register a search MCP server for the captain only. Rejected as insufficient
   alone: it answers search but not the authenticated, JavaScript-heavy, or
   multi-step pages that a real lookup reaches.
3. Mount `agent-browser` as an eve MCP connection on the captain. Rejected
   twice over: `defineMcpClientConnection` requires a URL speaking Streamable
   HTTP or SSE and `agent-browser mcp` is stdio-only, and even bridged it
   would put process ownership in the captain and replace doctrine projection
   with eve's static allow/block filter.
4. Re-enable eve's built-in web tools and give the captain `agent-browser`
   with its full action set, hosted by the runner. Accepted.

## Decision

**Web reach joins the bank.** `web_fetch` and `web_search` return as framework
tools. `web_fetch` has a real in-process executor and works on every model.
`web_search` is provider-backed — eve resolves a native backend for direct
OpenAI, Anthropic, and Google models and none for other providers, so the tool
is absent on some models. No Vercel AI Gateway is involved: that path applies
only to gateway id-string models, and every Clankie model is BYO through the
credential broker. The captain's instructions require him to say he cannot
search rather than answer from memory when the tool is absent.

**Shell and filesystem stay disabled.** `bash`, `read_file`, `write_file`,
`glob`, and `grep` remain `disableTool()`. That is the property ADR 0027 was
actually protecting, and it is unchanged. ([ADR
0086](0086-clankie-holds-a-shell.md) later splits that property: `bash` and
`read_file` return as runner-hosted tools, and the write boundary moves into the
runner's sandbox rather than resting on the tools' absence.)

**`agent-browser` becomes Clankie's browser, not a worker's tool.** The runner
hosts it as a stdio MCP server (`agent-browser mcp --tools all`) and the
captain reaches it through the control plane like every other capability. It
is registered in the operator-authored MCP registry with one risk class per
tool, so it is governed by the same doctrine vocabulary as every other
connector.

**The profile is his, and it persists.** A browser that forgets every session
turns each lookup behind a login into a password request, which is the
opposite of the capability being added. The profile therefore lives in the
runner's private state root and is reused across runs
(`AGENT_BROWSER_RESTORE_SAVE=always`, the deliberate opposite of the Codex
projection's `never`). It is Clankie's own profile, never the operator's
browser. The accumulated credentials are precisely why
`agent_browser_set_credentials`, `agent_browser_eval`, and
`agent_browser_get_cdp_url` are approval-class: the profile gets more valuable to an attacker
over time, so the verbs that could exfiltrate it stay behind a human.

Unlike the Codex projection, the captain's browser carries **the full action
set**. The read-only policy that gates the Codex shell (`navigate`, `snapshot`,
`scroll`, `wait`, `read`, `get`) is a worker-shaped restriction; a
general-purpose seat that can read a page but never fill a form is not doing
the job asked of it.

**`require_approval` grants for the captain instead of withholding.**
`projectCaptainMcpToolGrants` differs from `projectMcpToolGrants` in exactly
one way, and it is the safety mechanism that makes the full action set
tractable. A worker cannot pause mid-tool for a human, so an approval-class
tool in a worker's set would either execute unapproved or deadlock — hence the
worker rule. The captain is the seat that *owns* the approval envelope, so
withholding approval-class tools from it would mean no principal could ever
perform them. `deny` still denies, and an undeclared tool is still never
projected.

```mermaid
flowchart TB
  TUI[TUI lane] --> C
  DT[Discord text] --> C
  SL[Slack / Linear] --> C
  V["Discord voice<br/>sole tool: ask_clankie"] --> C
  C["Captain — the one tool bank"]
  C --> W["web_search · web_fetch<br/>reflex lookup"]
  C --> B["browser__agent_browser_*<br/>full action set"]
  C --> D["delegate → workers<br/>bounded investigation"]
  B --> G{"doctrine risk class"}
  G -->|allow| R["runs unattended<br/>open · screenshot · click · fill"]
  G -->|require_approval| A["approval envelope<br/>eval · set_credentials · get_cdp_url"]
  G -->|deny| X[absent]
```

## Consequences

- Every lane gains lookup at conversational cost. A question asked in voice is
  answered on the same path as one asked in the TUI, which is what one
  character with one bank was always supposed to mean.
- **A full-action browser sits behind `ask_clankie`, so untrusted room text can
  reach it.** This is the real cost of the decision and it is accepted
  deliberately. Three things bound it: the browser runs on Clankie's own
  profile rather than the operator's, every credential- or script-bearing verb
  (`eval`, `set_credentials`, `get_cdp_url`) is approval-class and stops for a
  human, and
  the registry stays a closed list so an undeclared tool is never projected.
  Room speech still never carries approval authority
  ([ADR 0050](0050-voice-presence-authority-tier.md)). The persistent profile
  raises the stakes over time rather than lowering them, which is the reason
  the approval gate is enforced at the control plane on every call instead of
  by a step-scoped hook that a replayed turn could skip.
- Risk classes are assigned per tool against the names `agent-browser mcp
  --tools all` actually advertises (64 at v0.33.2), not against the CLI's
  documented command groups. An earlier draft classified thirty-three guessed
  names and would have projected nothing at all, because the host drops
  anything the registry does not declare — a typo silently removes a
  capability rather than failing loudly. Verify against a live `tools/list`
  when upgrading agent-browser.
- The high-assurance overlay's exact `web.search` / `web.fetch` denials still
  bind, and an overlay can deny any `mcp.agent_browser.*` action outright.
- `web_search`'s provider dependence is a known seam. Because eve documents
  overriding it with `defineTool()`, the browser host makes a
  provider-independent implementation possible later; until then the tool's
  absence is disclosed to the model rather than hidden.
- Workers keep everything they had. The Codex read-only browser projection and
  the Claude native web research path are unchanged.

## Status of the work

Landed end to end: web reach restored to the bank with the instruction that
governs it; `projectCaptainMcpToolGrants`; the `agent_browser` registry entry
with all sixty-four tools classified; the runner's stdio MCP host and
loopback browser gateway; the control-plane `/v1/browser/tools` and
`/v1/browser/call` routes with the approval gate; and the captain's
`defineDynamic` tool set.

Proven live against agent-browser 0.33.2 and Chrome 151: 64 tools projected,
14 approval-gated (every irreversible-write, publish-external, and destructive
class under `self-build-lab`), with `agent_browser_open` and
`agent_browser_get_title` returning a real page title. Reads and page
interaction — including `click`, `fill`, and `screenshot` — run unattended.

`CLANKIE_BROWSER_ENABLED` **defaults on**, and only an explicit falsey value
turns it off. Opt-in was the wrong default for the same reason the disabled
web tools were: a browser nobody remembers to enable is a capability he
truthfully denies having, which is the failure this change set exists to
remove. Enabling is not granting — a compiled doctrine profile and a registry
are still both required, and a missing binary degrades to a logged
unavailability rather than a boot failure. Those two stay explicit on purpose:
the profile decides what he may actually call, so defaulting it would silently
choose a permissive lab profile on someone's behalf.

Not yet landed: the free-play mind still has no route to the bank. The obvious
fix — an `ask_captain` field on the player's decision — is the one
[ADR 0056](0056-voice-is-a-separate-agent-from-the-player.md) measured as
harmful: loading a second job onto the player's single call is what suppressed
speech (0 of 12 across four prompt revisions) until speech became its own
agent. The right shape is therefore to route an interjection to the existing
`gameplay` captain lane rather than to widen the player's schema. In a voice
room the question already reaches the captain through `ask_clankie`, so the
gap is narrower than it looks: it is interjections delivered straight into the
loop.
