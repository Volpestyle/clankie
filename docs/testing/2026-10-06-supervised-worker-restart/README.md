# VUH-1739 supervised restart candidate

**Security review HOLD on `65f5be1e`.** The enabled path is not approved for
integration or existing-lane use. The owned positive run below establishes
mechanical behavior, not a safe concurrent handoff. Main retains the separately
reviewed early refusal staging.

Installed Codex 0.160.0 and Herdr 0.9.3 passed the manual owned-native check on
2026-10-06. [Content-free result](native.json) records the successful restart and
refusals. The test creates only its own Herdr namespace, native controller,
private configuration and thread, using an already linked account through its
existing pointers. No existing lane, account credentials or original owner
conversation was changed. No model/provider turn was requested.

Normal double Ctrl+D quit was followed by kernel absence of the original TUI
PID. Herdr's foreground-shell launch then resumed the same thread in the same pane/seat,
with a new TUI PID, original cwd and saved context. The original local Unix
controller/account/configuration remained. A real unsent draft, real native
busy shell task, wrong HTTP bearer and terminal-ID alias all refused; refused
requests left their current TUI PID unchanged. Busy requests are not queued for
an automatic later restart.

The API/CLI/tool exposes explicit `restart:true` / `--restart`. Deployment
polling diagnoses `restart-needed`. Quit and resume intent are separately
fsynced before dispatch. Lost quit/reload/resume replies remain held and cannot
be automatically replayed. Existing canonical receipt checks remain in Captain.
The owned direct HTTP fixture does not prove production Captain admission or
an old retained report's settlement.

## Security and acceptance boundaries

Pell's distinct read-only review found three blockers in the frozen source:

- After the original TUI exits, awaited thread/configuration reload operations
  leave time for new shell input. Herdr `agent.start` checks the foreground
  shell, then appends the command and Enter; it does not reject an unsent draft.
- Quit and start resolve a pane at effect time without an expected original
  terminal/process lifetime. A replacement occupant can receive those bytes.
- Success must independently reprove resumed argv/endpoint, canonical
  executable, actual cwd, and original controller/account/loaded thread.
  A Codex basename and reported thread are insufficient.

Repeated kernel/controller/owner/draft reads do not make either input effect
conditional. Installed Herdr 0.9.3 exposes no verified shell input buffer or
conditional empty-draft launch. A prompt-text heuristic cannot close this gap.
The lead must select a guarded native input mechanism or retain safe refusal;
no new native exit capability is proposed. No existing lane was touched.

Required owned checks after correction: insert a harmless draft during the
post-quit reload and preserve it without Enter; replace the pane/controller
during the handoff and refuse before any replacement receives input; inject a
real production retained claim/receipt at the final authority boundary and
preserve it until exact settlement. These negative handoff cases have not run.
The review confirmed source interleavings, not an executed exploit. Its full
report remains in the integrator's `.local/supervised-1739-review/REPORT.md`.

Bare local launches refuse `shell_account_unproven`: initial kernel environment
strings cannot prove the shell's current exported account selection. The positive check covers the original dedicated local Unix
controller mode. Other loaded roots refuse. Remote PCs/Claude remain VUH-1742.

A successful mechanical restart does not prove that an actual pre-0.6.5 seat
loads the current peer tools and makes a new stored report after its original
receipt settles. That live canary, security review, integration and deployment
remain open. Keep VUH-1739 open until the lead attaches that evidence.

Reproduce with both fleet heavy wrappers and:

```sh
SUPERVISED_CODEX_ACCOUNT_HOME="$CODEX_HOME" SUPERVISED_CODEX_RESTART_TEST=1 \
  pnpm exec vitest run apps/clankie/test/supervised-codex-restart-native.integration.test.ts
```

The busy task uses native `thread/shellCommand` to run bounded `sleep 6`, without
requesting a model turn. Raw local evidence is under `.local/1739/supervised-*`.
