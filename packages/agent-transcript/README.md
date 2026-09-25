# Agent transcripts

The service and native-seat CLI share harness transcript parsing, bounded display
records and redaction. Herdr discovery still supplies native session references
for fleet observation; `clankie seat-sync` receives Claude's explicit hook path
on the Claude host. No service request reads that path remotely.

`SeatTranscriptUploadSchema` permits at most 100 normalized messages/tools per
request and optional native hook activity on the final page. It excludes host image
paths. The native reader retains the existing 9,000-entry display tail, follows the
active Claude/Pi parent chain (including parallel Claude tool results), and tails
flat Codex/Grok records incrementally. Native-seat hooks publish settled history,
not live model drafts. Older records outside that tail are not a full transcript
archive; publishing a viewed image uses Clankie's existing file-delivery path.

`sessions.ts` reads the same transcripts from any host that can list its
Claude/Codex files and return a byte range of one (`AgentTranscriptHost`;
`@clankie/agent-hosts` supplies local and SSH hosts). A tail widens from 256 KiB
toward the host's 4 MiB read cap. A cursor carries the session, the byte offset and
a hash of the bytes before it, so a page after it detects a replaced file and
restarts from the tail. Pages re-read 256 KiB before the cursor so tool results and
Claude's parent chain resolve, and report only entries that changed.
