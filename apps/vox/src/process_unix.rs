//! Unix process management helpers.
//!
//! The music and stream-publish paths build POSIX shell pipelines around
//! `ffmpeg`, `yt-dlp`, and process groups. Keep that contract explicit instead
//! of carrying Windows branches that cannot run the generated commands.

#[cfg(not(unix))]
compile_error!("clankvox media subprocess pipelines require a Unix-like shell and process groups.");

use std::io;
use std::process::Command;

use tracing::warn;

// ── Shell quoting ──────────────────────────────────────────────────────────

/// Quote a string for embedding in a shell pipeline command.
pub(crate) fn shell_quote(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{escaped}'")
}

/// Build a shell fragment that resolves a YouTube/extractor URL to a direct
/// media URL through `yt-dlp --print urls`.
pub(crate) fn ytdlp_resolved_input(url: &str, format_selector: &str) -> String {
    ytdlp_resolved_input_with_client(url, format_selector, "android")
}

pub(crate) fn ytdlp_resolved_input_with_client(
    url: &str,
    format_selector: &str,
    player_client: &str,
) -> String {
    let quoted_url = shell_quote(url);
    let quoted_format = shell_quote(format_selector);
    let yt_arg = shell_quote(&format!("youtube:player_client={player_client}"));
    format!(
        "\"$(yt-dlp --no-warnings --quiet --no-playlist --no-live-from-start --extractor-args {yt_arg} -f {quoted_format} --print urls {quoted_url} | sed -n '1p')\""
    )
}

/// Remove URL-bearing credentials from subprocess diagnostics before they
/// cross the native process boundary.
pub(crate) fn redact_urls(input: &str) -> String {
    const SCHEMES: [&str; 3] = ["https://", "http://", "wss://"];
    let mut output = String::with_capacity(input.len());
    let mut remaining = input;

    while let Some((start, scheme)) = SCHEMES
        .iter()
        .filter_map(|scheme| remaining.find(scheme).map(|start| (start, *scheme)))
        .min_by_key(|(start, _)| *start)
    {
        output.push_str(&remaining[..start]);
        output.push_str("[redacted-url]");
        let url = &remaining[start + scheme.len()..];
        let end = url.find(char::is_whitespace).unwrap_or(url.len());
        remaining = &url[end..];
    }
    output.push_str(remaining);
    output
}

// ── Shell spawning ─────────────────────────────────────────────────────────

/// Create a `Command` that runs `pipeline` through the platform shell.
///
/// The returned `Command` already has a new process group configured so that
/// the entire child tree can be signalled together.
pub(crate) fn shell_command(pipeline: &str) -> Command {
    use std::os::unix::process::CommandExt as _;
    let mut cmd = Command::new("sh");
    cmd.process_group(0);
    cmd.args(["-c", pipeline]);
    cmd
}

// ── Process signal abstraction ─────────────────────────────────────────────

/// Signals that `music.rs` and `stream_publish.rs` need to send.
#[derive(Debug, Clone, Copy)]
pub(crate) enum ProcessSignal {
    /// Graceful termination (SIGTERM).
    Terminate,
    /// Suspend execution (SIGSTOP).
    Suspend,
    /// Resume execution (SIGCONT).
    Resume,
}

/// Send a signal to a process group rooted at `pid`.
pub(crate) fn signal_process_group(pid: u32, signal: ProcessSignal) -> io::Result<()> {
    if pid == 0 {
        return Ok(());
    }

    let sig = match signal {
        ProcessSignal::Terminate => libc::SIGTERM,
        ProcessSignal::Suspend => libc::SIGSTOP,
        ProcessSignal::Resume => libc::SIGCONT,
    };
    // SAFETY: pid originates from Child::id(), the child was spawned with
    // process_group(0), and we guard against pid==0 above.
    #[allow(unsafe_code)]
    let rc = unsafe { libc::killpg(pid as libc::pid_t, sig) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Helper: send [`ProcessSignal::Terminate`] to a child process, logging on
/// failure. The `context` label disambiguates the call site in log output.
pub(crate) fn terminate_child(child: &mut std::process::Child, context: &str) {
    if let Err(error) = signal_process_group(child.id(), ProcessSignal::Terminate)
        && error.kind() != io::ErrorKind::NotFound
    {
        warn!(pid = child.id(), error = %error, "{context}: failed to signal process group");
    }
}

#[cfg(test)]
mod tests {
    use super::{redact_urls, ytdlp_resolved_input};

    #[test]
    fn ytdlp_resolved_input_prints_first_resolved_url() {
        let input = ytdlp_resolved_input(
            "https://www.youtube.com/watch?v=abc123",
            "bestvideo+bestaudio/best",
        );

        assert!(input.contains("yt-dlp"));
        assert!(input.contains("--print urls"));
        assert!(input.contains("--no-live-from-start"));
        assert!(input.contains("sed -n '1p'"));
        assert!(!input.contains("-o -"));
    }

    #[test]
    fn subprocess_diagnostics_redact_signed_urls() {
        assert_eq!(
            redact_urls("input https://cdn.example/video?sig=secret failed"),
            "input [redacted-url] failed"
        );
    }
}
