# apps/vox/src/process_unix.rs

Provides Unix-only subprocess primitives shared by music and video publishers: POSIX shell quoting, signed-URL redaction, yt-dlp URL resolution, process-group creation, and SIGTERM/SIGSTOP/SIGCONT delivery. `terminate_child` sends SIGTERM to the whole group and logs non-`NotFound` failures; it does not wait, escalate to SIGKILL, or impose a timeout, so callers own waiting and detached joins.
