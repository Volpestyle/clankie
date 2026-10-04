# Remote Claude tracker isolation — 2026-10-04

[VUH-1527](https://linear.app/vuhlp/issue/VUH-1527) source correction. This
checkpoint is not deployed or verified against a live PC agent.

Before starting a remote Claude worker, Clankie reads the supported SSH
environment's default user configuration and, when set to an absolute path,
`CLAUDE_CONFIG_DIR/.claude.json`. It includes applicable ancestor project maps
from both files and `.mcp.json` at the requested working directory and each
ancestor. Windows comparisons respect drive/share roots and case; POSIX
comparisons remain case-sensitive. The same existing Linear classifier produces
session-only deny rules. No owner configuration is rewritten.

The collector runs once through the existing fleet shell transport and installed
worker's Node prerequisite. It returns server identifiers, URL hosts without
credentials/path/query, and a fixed command-classification marker. Full command
arguments, environment values and configuration bodies stay on the remote
machine. Failures report a generic configuration-read error, not native stderr.

Bounds are explicit: ten-second shell request, 64 directory levels, 66 distinct
file candidates, 256 KiB per file, 2 MiB total source bytes, 128 source maps and
512 KiB reply. Windows commands above 30,000 characters are refused before SSH.
The existing SSH subprocess also retains its eight-MiB transport buffer limit.
Missing files are inert. Present unreadable, dangling, nonregular, malformed or
oversized files prevent launch. A source with an own `__proto__` server name
also prevents launch: the installed schema parser cannot preserve that identifier,
and silently omitting its deny rule would be unsafe. A missing Node runtime, incompatible platform,
relative configured profile path or failed transport also prevents launch. There
is no alternate launcher, arbitrary profile search, retry or configuration write
in this read.

This supported contract does **not** prove that a custom Herdr launcher selects
the same profile as SSH. Remote account overrides remain explicitly unsupported
by the existing hire API. The owner must establish the intended default profile,
matching installed plugin, channel approval and native compatibility during
acceptance. The read is a bounded snapshot, not an atomic transaction with a
later native launch; normal filesystem/SSH timeout limitations remain.

## Verification

The original source failed the alias-named Linear URL fixture: the `.mcp.json`
connector was missing from deny rules. The corrected source runs the exact
generated collector against temporary POSIX files and finds it. Further fixtures
cover selected/default configs, ancestor maps, sibling exclusion, literal shell
metacharacters, sanitized output, source/reply/depth/command bounds, and failure
before native start or launch-settings write.

Windows fixtures decode the real generated PowerShell/argv envelope and execute
the same Node collector with `node:path.win32` and a read-only fake filesystem.
They verify drive/UNC roots, mixed separators and casing, but do not claim a
Windows native execution or SSH acceptance. POSIX fixtures execute the generated
command against temporary files and verify their bytes are unchanged.

The separate Claude Stop/completion correction, current connected-tool policy
and hired Codex registry are unchanged by this slice. Actual remote hire,
followup, completion wake and hand-started reply acceptance remain owner checks.
