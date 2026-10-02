# VUH-1468: Codex operator plugin

The implementation is ready for owner review. **Full live acceptance is blocked
on the owner's native Codex hook trust.** No hook trust was approved, bypassed,
or written by this worker.

## Live observation

- Codex 0.159.1 installed the native plugin manifest with `codex plugin add`.
- A new scratch conversation, `conv-607f7c31-6b36-47a3-b6bf-120ab9ce75f1`, had
  `isDefault: false`. The owner's global-default conversation was not used.
- The real Codex TUI ran in owned Herdr pane `w2H:p6S`, attached to its dedicated
  app-server socket. Both native commands appear in [live.json](live.json).
- Codex displayed **Hooks need review: 6 hooks are new or changed**, with native
  review, trust, and continue-without-trusting options. [Terminal capture](hook-trust.txt).
- While review was pending, the scratch conversation remained unbound with an
  empty transcript. Identity, memory, MCP tool execution, app transcript, and
  wake delivery therefore remain **unverified live**.
- The native TUI and owned app-server exited, the test pane and scratch
  conversation were closed, and the temporary authentication symlink and worker
  plugin install were removed. No shared daemon, service or owner seat restarted.

The first attempt used this worker's inherited Codex home. Codex rejected its
symlinked `app-server-control` directory even with a dedicated socket. The retry
used a fresh temporary Codex home and a temporary link to the existing login;
no credential contents were copied into evidence. The review dialog exposed a
15-second startup timeout in the shared driver; its owner added an explicit
review timeout and cancellation signal in `268565b9`. This launcher uses them.

A fresh install also revealed that Codex skips symlinks when copying plugins.
The build now materializes an ignored skill snapshot from the canonical shared
sources. A clean native reinstall confirmed ordinary skill directories in its
cache. Release assembly uses the same canonical bundle. Dead-code and link
checks exclude this generated copy and continue checking the authored sources.

## Checks

[Focused output](focused-tests.txt): **36 tests passed across 5 files**. These
cover the generated identity, native hook declarations, root-session binding,
child exclusion, memory re-arming and deduplication, transcript redaction,
selected-conversation delivery through the shared driver, waiting for trusted
hooks before binding the outbox, preserving injected context when transcript
sync fails, startup cancellation, Claude isolation, and
release skill packaging. The delivery test uses a fake outbox and driver; it is
not the missing live wake check.

All 27 workspace typechecks passed. The first `pnpm check` attempts stopped on
other owners' in-progress formatting and documentation changes; those owners
fixed them. The final `pnpm check` exited 0: 380 test files, 3,229 passing tests (2 skipped),
123 Rust tests and the Vox IPC smoke check. [Check output](check.txt).

## Owner completion

Install the plugin into the Codex home you normally use:

```sh
node integrations/codex-plugin/build.mjs
codex plugin marketplace add /Users/james/dev/clankie/integrations/codex-plugin
codex plugin add clankie@clankie-seat
clankie seat --harness codex --conversation NEW_SCRATCH_CONVERSATION_ID
```

Review and trust its native hooks yourself. Keep the plugin disabled globally
in `/plugins`; the launcher enables it for its own seat. If startup hooks were
skipped, exit and repeat the launch command after review. Then verify identity,
the first and changed memory cards, a Clankie MCP tool, the resulting app
transcript, and a scheduled wake delivered to that thread. Close the scratch
seat and conversation afterward. The source and operating instructions are in
the [plugin README](../../../integrations/codex-plugin/README.md).
