# Codex hire bootstrap proof — VUH-2143

Tracks: https://linear.app/vuhlp/issue/VUH-2143/fix-local-codex-hook-overlay-and-pc-app-catalog-hire-failures

Source: `2a5cf649e`, based on fetched `origin/main` `695ef2fa2`.

The PC's installed command is its selected-account `codex.cmd` wrapper. The original read-only catalog program failed with `spawn codex.exe ENOENT`. The patched program uses that launcher and returns 15 installed apps, including Linear. The production remote tracker reader also runs successfully over SSH and produces a session-only app-disable override. Child startup/stderr/exit, RPC and remote shell errors remain visible; discovery closes stdin to drain the launcher and native child.

The cited local failed overlay is dated October 4, 12:05 CDT. Existing fix `e0a3d02cd` landed at 12:21 CDT that day and already removes repeated hook-trust tables. A fresh overlay copied from the owner's current Codex home passes the real `codex mcp list --json` reader, with the owner config unchanged. No additional speculative local source change was needed.

39 focused tests pass across worker-skills, tracker-isolation and remote-codex-app-server, including the real local and PC boundaries. The native checks are opt-in (`CODEX_HIRE_NATIVE_HOME` and `CODEX_HIRE_PC_HOST`); ordinary gates retain deterministic consumer and diagnostic tests. Formatter and scoped lint passed on touched files. Exact-tree landing gate is supplied by the integrator.

No model turns, hires, WSL builds, tenant wakes, ops deploys, owner config writes, or changes to the KH2 lead's `pc/w14:p3` pane occurred. This proof establishes pre-hire discovery, not a completed KH2 hire.
