# Lead fresh restart: visible refusals, accepted budget and home trust

Work: VUH-2849, VUH-2821 criterion 4; upstream/default-workdir follow-up VUH-2863 under VUH-2820.
Base: `251de1c794876d5c2dbf02caf1a6f8d1a3081e78` (VUH-2860's receipt-bound successor and kept brief). Its late-bind and replacement-session protections remain covered by the existing relaunch integration suite.

## Result and proof boundary

The production captain rounds record `source_unproven` with the failed named inventory, or `usage_unreadable` with transcript candidates/search paths/read errors. The authenticated status route and CLI expose the refusal. `check.due` is absent when budget cannot be established; the CLI says `budget unknown`. The real persisted wait and conversation log produce one owner notice at two hours and retain it across a service reload. App/service leads without a native session are outside this native restart check.

The lead budget is 250,000 context tokens or 12 hours, with a 300,000-token `autoCompactWindow` in Claude's session settings. ADR 0293 is Accepted by the lead's explicit 2026-10-26 direction. Boundary checks exercise 249,999 just below 12h, 250,000 in a young session, and a small session at exactly 12h.

Installed Claude Code 2.1.310's acceptance handler branches on home: it sets in-process flags for home, and invokes the persisted `hasTrustDialogAccepted: true` callback for other directories. Its own diagnostic says home trust is session-only. `claude-trust-trace.json` records the installed binary SHA-256 and those short source fragments. This is a source trace, not a replay of a vendor trust prompt. No real Claude process or owner trust config was used.

The launcher takes global-default's directory from the service seat-context, overriding its shell cwd. A relaunch whose resolved directory is home (including a symlink to home), missing or unresolvable refuses `trust_required` before termination. Even a true persisted home flag cannot waive this check. The refusal and two-hour notice name the owner action: choose a trusted project with `clankie workdir set PATH`, restart captain when authorized, then open the conversation with the selected account and accept trust there once. VUH-2863 tracks the product/default-workdir decision outside this path. This change does not pre-accept any trust decision.

## Verification

`proof-bundle.json` contains the four named captures below; fetch it through the manifest link after upload.

- `focused-results.json`, `focused.log`: four focused suites covering the production captain round/status route, existing receipt rebind/late kept brief/replacement-session controls, the launcher plan, trust refusal and the real Herdr proof.
- `scratch-relaunch.json`: isolated Herdr starts with **0 restored workspaces**. HOME, CLAUDE_CONFIG_DIR, every XDG root and Herdr socket/config/session are scratch. A fixture vendor executable starts through the real `planSeat`, emits a labeled empty composer and records argv/settings. The production relaunch reads actual Herdr process inventory, signals the owned old process, waits for the shell, launches one fresh session without `--resume`, and hands its brief to that successor's binding. A subsequent home-trust refusal leaves that successor alive, starts nothing and leaves the scratch Claude config byte-identical.
- The vendor executable is a stand-in: this proves real shell/process/launcher/receipt behavior, not vendor login, native MCP acknowledgment or an actual Claude trust dialog. Existing VUH-2860 tests separately prove the production captain poll/rebind/outbox acknowledgment path.
- The initial service source typecheck passed, then test typechecking found four optional-port call errors in the new tests. Those calls were corrected; the required landing gate is the final check record.

No live lead pane was restarted or typed into, no owner-visible GUI prompt was opened, and no real `~/.claude.json` was edited. The scratch Herdr daemon and its panes are stopped in teardown. Live restart/deployment, tomorrow's context median and the parent project's week-long token/output criteria remain unverified and open.

## Landing

The exact committed patch must pass `clankie heavy -- pnpm check:landing`, receive the standing reviewer's APPROVE, and pass revalidation before push. Final gate/review/commit links are attached to VUH-2849; evidence upload links are in `evidence.json`.
