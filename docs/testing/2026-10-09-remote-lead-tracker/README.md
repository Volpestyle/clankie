# Remote lead tracker delegation — VUH-1968

[Issue](https://linear.app/vuhlp/issue/VUH-1968).

## Cause and repair

The remote bridge filtered the real conversation tool bank through a fixed
lead-tool allowlist. That discarded the connected tracker's initial `linear_*`
tools and its deferred service directory, explaining the live 13-tool catalog.

The delegated bank now restricts direct tools and deferred discovery/calls to
the ordinary tracker surface. Other connected services, raw GraphQL,
persona-selectable worker publishing and owner repository overrides are refused.
Reads and writes carry the host-bound lead chat attribution. The MCP host's
existing asynchronous/synchronous dispatch fence rechecks the delegation after
setup and at writes. Required attribution refuses rather than falling back to
an unattributed connected-account call. Ordinary callers keep their optional
attribution semantics. No protocol schema, product timeout or machine ceiling
was changed.

`linear_wake` is restricted to receiving an original wake in that chat; it cannot
read/change owner rules or routing. Owner HTTP APIs remain inaccessible to the
remote delegation. See [ADR 0259](../../adr/0259-remote-project-leads-use-seat-bound-delegation.md).

## Acceptance fixture

The existing real-launch integration case now reaches the real captain,
ConversationStore, delegated HTTP/MCP bridge and MCP host. Native Windows/SSH
observation and provider responses remain explicit fixtures. It proves direct
issue reads/comment writes, deferred issue writes, host-stamped chat attribution,
non-tracker/GraphQL/persona/repository refusals, wake-setting refusal and a write
revoked during asynchronous credential setup without provider dispatch.

Focused checks passed **14/14**, exit 0: the real launch integration,
standalone bridge/HTTP contracts and existing MCP attribution contracts. The
revoked write returned a real host refusal with `possiblyDispatched: false`,
with the provider call count unchanged; the original MCP caller wait was
cancelled after revocation closed its transport.

The repository-root landing gate's final results and checked source/base will
be attached to the issue after reading the results, before push. A fixture pass
does not establish live head acceptance.

## Live routing and remaining acceptance

On 2026-10-09, verified the workspace-owned Clankie OAuth actor and read the
Linear project and full conversation identity before writing the route:

- Linear project: `b701962e-89aa-4685-a574-ebda25706d64` (KH2 Multiplayer).
- Chat: `conv-7687818a-09c3-4f37-bf7b-9d201c2e1932` (KH2 lead).
- Scope: workspace `C:\Users\volpe\repos\kh2-multiplayer`, machine `pc`.
- `clankie linear routes set --json-stdin` succeeded; `routes show` read back
  that exact route and the unchanged Clankie Work route.
- Project read receipt: `3ea43153-014b-4a6c-8943-1f5744daf426`.

The lead will redeploy/relaunch. The live KH2 head must then read an issue and
post a comment through Clankie's tracker tools, and verify an owner-origin KH2
wake reaches this chat. No deployed acceptance, restart, PC pane typing or
existing worker takeover is claimed here.
