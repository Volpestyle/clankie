# VUH-1739 supervised restart candidate

Installed Codex 0.160.0 and Herdr 0.9.3 passed the manual owned-native check on
2026-10-06. [Content-free result](native.json) records the successful restart and
refusals. The test creates only its own Herdr namespace, native controller,
private configuration and thread, using an already linked account through its
existing pointers. No existing lane, account credentials or original owner
conversation was changed. No model/provider turn was requested.

Normal double Ctrl+D quit was followed by kernel absence of the original TUI
PID. Herdr's guarded launch then resumed the same thread in the same pane/seat,
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

Herdr keyboard quit has no atomic expected-lifetime/idle/draft condition.
Repeated kernel, controller, owner and styled-draft checks precede dispatch;
concurrent owner input, native busy transitions or pane reuse can still race
that boundary. Herdr's guarded shell launch does not make the prior quit
conditional. This is an explicit security-review requirement, not a proven
race-free operation. Do not use this candidate on existing lanes before review.

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
