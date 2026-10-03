# OpenCode operator seat verification — 2026-10-03

Implementation: VUH-1469. The BUILD decision is resolved; live acceptance is
not complete. No eval campaign, account comparison, service restart, owner
permission approval or owner configuration apply was performed.

The installed `/Users/james/.opencode/bin/opencode` initially reported 1.18.29.
A later invocation and owned Herdr TUI reported 1.18.34. The TUI process argv
confirmed the same absolute executable; the cause of this version drift was
not proven. The launcher explicitly disables native auto-update per launch.

A plugin inside an owned native interactive TUI successfully created a scratch
native session, got that exact session back, and read its status and messages
using the injected SDK client. The plugin context's server URL was 4096 despite
`--port 0`; the integration deliberately never uses that URL for discovery.

The running service predates the `ses_*` transcript-upload schema addition.
Full live projection therefore needs an updated service operated by its owner;
this work does not authorize a service restart. Tests validate the new contract
and reject unrelated/invalid session identifiers.

Local evidence is retained under
`~/.herdr-handoffs/clankie-backlog-20261003/evidence/VUH-1469/`.
Scoped native acceptance then used that exact session in the real TUI:

- The live model identified itself as Clankie and confirmed an operator memory
  card was present, without quoting private memory facts.
- `clankie_get_self_state` completed through the broker-backed operator MCP.
- A synthetic wake through the shared native delivery helper produced
  `OPENCODE_WAKE_1469` while the native composer retained
  `UNSENT_OWNER_DRAFT_VUH1469`. The helper's claim and receipt callback was an
  isolated fixture; this was not a production outbox wake.
- A harmless `printf` shell request reached native permission approval. No
  approval was supplied. Native status was busy, and the delivery helper
  returned busy without claiming or dispatching another turn.
- Real captured native user/assistant/tool records passed the current
  `createClankieApp` transcript route and real `ConversationStore` in an isolated
  fixture, with status 200 and role-correct replay. Synthetic wake text was not
  misrepresented as an owner message.

Only owned scratch panes/processes were closed. The scratch conversation and
native session remain as evidence. Three narrowly scoped native requests were
made; no eval campaign or model/account comparison was performed.

The running older service still cannot project OpenCode IDs. A complete live
service outbox-to-native-to-app cycle remains unverified. A local exported
launch API and CLI are implemented; a remote HTTP terminal-launch endpoint is
not supplied (the existing Claude/Codex seats use the same local launch seam).
Silent TUI navigation to another existing session has no verified server event;
delivery stays bound to the original ID, with switching detected at a new root
session or another session's prompt. These limitations remain explicit, and the
issue is not claimed Done.

Readiness limitation: both a new seat and an idle resumed seat activate the
outbox only after a native turn runs the system-context hook. Opening or resuming
the TUI alone does not yet bind wakes. This is an implementation limit, not a
successful startup-delivery proof.
