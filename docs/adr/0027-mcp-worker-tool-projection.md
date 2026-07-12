# ADR 0027: Doctrine-projected MCP worker tools and native web research

Status: accepted (James, 2026-07-12).

## Context

Workers previously had no path to external capabilities: the captain's framework tools are
disabled by design, worker tool networking is off, and the only real connectors (Linear, Discord)
run on the control plane. Doctrine is already connector-neutral and MCP-first — every connector
action declares one risk class and unclassified actions are denied — but no runtime could attach
an MCP server, so integrations the owner wants (Linear, Aseprite, Figma, GitHub, Blender, Unreal
Engine) and web research had no sanctioned mechanism.

Options weighed:

1. Re-enable the captain's eve web/file tools. Rejected: the tool-less captain is the
   architecture's core safety property; execution belongs in governed workers.
2. Bespoke connector adapters per vendor. Rejected: doctrine explicitly avoids vendor nouns, and
   per-vendor code cannot keep pace with an open MCP ecosystem.
3. An operator-authored MCP registry projected through doctrine into provider-native harness
   MCP support. Accepted.

## Decision

`@clankie/mcp-registry` defines a trusted, operator-authored YAML registry
(`CLANKIE_MCP_REGISTRY`, example at `doctrine/mcp-registry.example.yaml`). Each server declares a
transport (stdio or http), a positive credential-environment allowlist, optional task-kind
scoping, and an explicit tool list where every tool carries exactly one connector risk class.
`narrative-write` is excluded; that class remains the closed tracker/presence whitelist.

The runner projects each declared tool as the action `mcp.<server>.<tool>` through the compiled
doctrine profile. Only an exact `allow` reaches a worker: workers cannot pause mid-tool for a
human, so `require_approval` and `deny` both withhold the tool, and approval-gated actions stay on
the privileged connector path. Without a compiled doctrine profile nothing is projected.

Projection is per harness. The Claude worker filters per tool (`mcp__<server>__<tool>`
allowlist plus a PreToolUse hook that denies ungranted non-filesystem tools). Codex declares
servers as strict-config inline tables and cannot filter individual tools, so it receives a server
only when every declared tool is allowed. Pi remains offline by design. Worker adapters stay free
of doctrine dependencies (`arch:check` enforces this); they receive plain, pre-projected
configuration from the runner.

Native web research follows the same shape without a registry: `web.search` and `web.fetch` are
read-class connector actions. When `CLANKIE_CLAUDE_WEB_RESEARCH_ENABLED=true` and doctrine allows
the actions, the Claude worker gains its provider-native WebSearch/WebFetch tools on `research`
tasks only, and the worker advertises the `research` task kind. The high-assurance overlay denies
both actions exactly.

## Consequences

- New integrations are registry entries plus risk classifications — no doctrine or adapter code
  changes. Unknown tools stay denied.
- MCP server processes are connector adapters started by the harness on the runner host; they are
  not confined by the worker tool sandbox. The registry is therefore operator-trust configuration,
  and credential exposure is limited to each server's explicit allowlist.
- The runner logs the full projection (allowed actions, withheld actions with effects, withheld
  servers) at fleet build for auditability.
- Browser control is not covered here. The sanctioned follow-up is a browser-automation CLI (for
  example `agent-browser`) exposed to shell-capable workers under a network-enabled sandbox
  profile, or a browser MCP server registered like any other — either arrives behind its own ADR
  once network egress policy for shell tools is defined.
