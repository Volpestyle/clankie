# VUH-1887: readable MCP calls

Implementation changes the operator registration to `lead` and worker registration
to `worker` in both harness plugins. Claude launcher permissions accept both the
new name and legacy `clankie`. Catalog observations use the exact registered
namespace. Codex observations reject ambiguous active registrations; new managed
launches disable the legacy registration. Existing Codex sessions refresh their
original server key, including recovery of retained refresh journals.

MCP display results carry a short first text block and `structuredContent` with
an object-valued host payload. The service HTTP contract and durable receipt storage keep their original
format, so installed older CLI publishers keep working. The CLI publisher and
shared display formatter accept new structured results and retained text results. The standalone
worker ships the same projection as the protocol package. Result metadata, media,
errors and uncertainty survive projection.

Native proof uses an owned throwaway Claude Code pane (`w47:p0`), loaded plugin
directories and the real connected `linear_get_issue` call for VUH-1887. The before
call used the installed bridge. The after call uses this checkout's CLI bridge
against the running service. No service deployment or restart is part of this
proof. A separately created Terminal window attaches to the owned pane solely
for native window capture; neither the operator seat nor existing user panes
receive input.

The observed standalone-pane catalog warning is separate from the successful
operator read. It reports missing native session binding; this proof does not
claim that pane was a service-hired worker.

Inspected native captures are attached to [VUH-1887](https://linear.app/vuhlp/issue/VUH-1887):

- [Before: repeated server name and escaped payload](https://uploads.linear.app/75f1d1f0-542b-4095-9967-fd7b27093472/04d6be0b-6aff-42ed-a3d9-1fa5b7cf9ed8/44c0462d-ffb3-4138-b944-6f620b809a2b)
- [After: `plugin:clankie:lead` call](https://uploads.linear.app/75f1d1f0-542b-4095-9967-fd7b27093472/dcfa0991-beed-462f-90c0-657a799443a6/04d32db4-9ce5-4be2-b83e-e26e3e8618cc)
- [After: expanded object result](https://uploads.linear.app/75f1d1f0-542b-4095-9967-fd7b27093472/4fae7a61-0745-4509-b8eb-9b84048c441d/5097920d-e4e4-4d93-a010-403af3ebd34b)

Claude Code 2.1.295 collapses the completed tool call to its server name. The
expanded result contains a summary text block and an object in `structuredContent`.
The screenshots preserve native rendering; no reconstructed terminal output is used.

Focused verification passed protocol and CLI result decoding, old/new Claude and
Codex catalog resolution, managed launch settings, original-server Codex refresh,
worker channel delivery, and the native seat delivery suite (86 tests). Protocol,
TUI, and service typechecks passed. Rebased checks are recorded on the issue.

The remote-goal fixture prerequisite landed separately as `cec5c1e6a` (18 tests
passed). Its read-only `pane list` response preserves exact-occupant capability
checks while the command allowlist still excludes thread resume and dispatch.

Migration: update the launcher and plugins together for readable results. Older
plugins and existing sessions retain the legacy `clankie` namespace until their
normal restart; the service still accepts their original result contract. No
running seat is restarted by this change. Ambiguous Codex registrations fail
closed, and an existing session's refresh never rewrites the other server key.
No service deployment, release, or live worker refresh was performed.
