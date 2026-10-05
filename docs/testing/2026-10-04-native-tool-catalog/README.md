# Native tool catalog evidence (VUH-1653)

Linked Claude Code and Codex panes now distinguish a native accepted catalog
from the bridge's advertised catalog. Reports belong to the current native
occupant and session; they grant no tools or authority. The service compares
them with the current bridge and exposes `matched`, `mismatch`, or `unverified`
in the roster and the owner-only doctor API. Pane notices carry one fixing
action. A missing whole server is a mismatch when the native inventory proves
it absent; unavailable native evidence remains unverified.

## Native evidence

- [Claude Code 2.1.289](claude-smoke.json): an owned native TUI with a real SDK
  stdio server reported its accepted tool, showed a mismatch and fixing action,
  and rechecked after native `/reload-plugins`. A non-object root reproduced
  the client's whole-server rejection and produced an empty accepted catalog
  with a visible mismatch. Both operator and worker plugins pass the actual
  installed plugin validator.
- [Codex 0.160.0](codex-smoke.json): an owned native TUI attached to its own
  private app-server reported `message_clankie` from its original loaded
  thread. Observation used `thread/loaded/list` and thread-qualified
  `mcpServerStatus/list`; it neither resumed a substitute observer thread nor
  started a model turn.

Both smokes used isolated fixture endpoints. No model prompt, live Clankie
service contact, real account credentials, deployment, or service restart was
needed. Only resources created for these smokes were closed.

## Focused verification

- Eight focused health, hook, roster, protocol, and doctor files: **87 passed**.
  The health integration crosses real TCP listeners, local/remote fleet-link
  routing, the real app and captain, schemas, and credential/process boundaries.
  It verifies malformed reports, forged native identity, wrong-pane reports,
  missing process proof, and owner-only health reads.
- Five Codex catalog/controller/adapter/plugin files: **94 passed**.
- Roster file after the final full-catalog layout regression: **18 passed**.
- Adjacent health/fleet-link/native-chat/lane files: **37 passed**.
- Typecheck: `@clankie/protocol`, `@clankie/clankie`, and `@clankie/tui` passed.
- Knip: combined root and those three workspace scopes passed with no new
  findings. Earlier five composer-catalog/grok exports from a narrower scope
  were workspace-selection artifacts; batch 14's full check passed at
  `a4f17bee`. Those exports were left unchanged.
- Changed-source lint, formatting, and diff checks passed. The cheap
  `pnpm mcp:check` passed **32 checks** in 7.11 seconds and is already wired into
  the narrow push/PR workflow by VUH-1651.

The run commands and native observations are retained in the linked JSON
records. No full suite or native build was run.

## Limits and accepted decisions

Embedded or `--no-daemon` hand-started Codex has no attachable native catalog
endpoint. Its startup hook explicitly emits an unverified native notice;
doctor and the roster retain that status. Native introspection for embedded
Codex is follow-up work. The fixing action points to a Clankie-managed launch,
never the shared daemon: inherited `HERDR_PANE_ID` broke worker bridges on
2026-10-04.

Native smokes and real HTTP/service boundary tests were verified separately;
an accepted report flowing through production Herdr admission into doctor and
the roster was not run as one complete end-to-end journey. The operator Claude
TUI was not separately smoked, and clearing an already displayed Claude warning
was not separately exercised. Codex's production worker plugin pane rendering
was verified against its native `systemMessage` contract and subprocess/HTTP
boundaries, rather than loaded in the fixture smoke. The native fixtures
advertised one tool each; full current expected banks are covered by the
focused bridge/schema checks. No decisions remain open.
