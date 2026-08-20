use std::collections::VecDeque;
use std::io::{self, BufRead};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use crossbeam_channel as crossbeam;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio::time;
use tracing::{info, warn};

use crate::audio_pipeline::{AudioSendState, clear_audio_send_buffer};
use crate::ipc::MusicErrorCode;

const MUSIC_PIPELINE_STDERR_TAIL_LINES: usize = 24;
const MUSIC_DIRECT_SELECTOR: &str = "ba/bestaudio";
const MUSIC_HLS_SELECTOR: &str =
    "worst[protocol^=m3u8][height>=360][acodec!=none]/worst[protocol^=m3u8][acodec!=none]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MusicPipelineAttempt {
    Direct,
    Hls,
}

#[derive(Debug)]
pub(crate) enum MusicEvent {
    Idle {
        music_id: String,
    },
    Error {
        music_id: String,
        code: MusicErrorCode,
        diagnostic: String,
    },
    FirstPcm {
        music_id: String,
        startup_ms: u64,
        resolved_direct_url: bool,
    },
}

fn classify_music_pipeline_error(stderr: &str) -> Option<MusicErrorCode> {
    let normalized = stderr.to_ascii_lowercase();
    if normalized.contains("http error 403") {
        Some(MusicErrorCode::Http403)
    } else if normalized.contains("requested format is not available")
        || normalized.contains("format is not available")
    {
        Some(MusicErrorCode::FormatUnavailable)
    } else {
        None
    }
}

fn should_retry_music_pipeline(
    resolved_direct_url: bool,
    attempt: MusicPipelineAttempt,
    first_pcm_reported: bool,
    code: MusicErrorCode,
) -> bool {
    !resolved_direct_url
        && attempt == MusicPipelineAttempt::Direct
        && !first_pcm_reported
        && matches!(
            code,
            MusicErrorCode::Http403 | MusicErrorCode::FormatUnavailable
        )
}

#[derive(Debug)]
pub(crate) struct MusicPcm {
    pub(crate) music_id: String,
    pub(crate) samples: Vec<i16>,
}

pub(crate) fn drain_music_pcm_queue(music_pcm_rx: &crossbeam::Receiver<MusicPcm>) {
    while let Ok(mut chunk) = music_pcm_rx.try_recv() {
        chunk.samples.fill(0);
    }
}

pub(crate) fn is_music_output_drained(
    music_pcm_rx: &crossbeam::Receiver<MusicPcm>,
    audio_send_state: &Arc<Mutex<Option<AudioSendState>>>,
) -> bool {
    if !music_pcm_rx.is_empty() {
        return false;
    }
    let guard = audio_send_state.lock();
    guard
        .as_ref()
        .is_none_or(|state| state.music_buffer_samples() == 0)
}

#[derive(Clone, Copy)]
pub(crate) struct MusicPipelineRequest<'a> {
    pub(crate) music_id: &'a str,
    pub(crate) url: &'a str,
    pub(crate) resolved_direct_url: bool,
    pub(crate) clear_output_buffers: bool,
}

pub(crate) struct MusicPipelineContext<'a> {
    pub(crate) music_player: &'a mut Option<MusicPlayer>,
    pub(crate) music_pcm_rx: &'a crossbeam::Receiver<MusicPcm>,
    pub(crate) music_pcm_tx: &'a crossbeam::Sender<MusicPcm>,
    pub(crate) music_event_tx: &'a mpsc::Sender<MusicEvent>,
    pub(crate) audio_send_state: &'a Arc<Mutex<Option<AudioSendState>>>,
}

pub(crate) fn start_music_pipeline(
    request: MusicPipelineRequest<'_>,
    context: MusicPipelineContext<'_>,
) {
    let MusicPipelineRequest {
        music_id,
        url,
        resolved_direct_url,
        clear_output_buffers,
    } = request;
    let MusicPipelineContext {
        music_player,
        music_pcm_rx,
        music_pcm_tx,
        music_event_tx,
        audio_send_state,
    } = context;

    if let Some(player) = music_player {
        player.stop();
    }
    *music_player = None;
    drain_music_pcm_queue(music_pcm_rx);
    if clear_output_buffers {
        clear_audio_send_buffer(audio_send_state);
    }
    *music_player = Some(MusicPlayer::start(
        music_id,
        url,
        music_pcm_tx.clone(),
        music_event_tx.clone(),
        resolved_direct_url,
    ));
}

pub(crate) struct MusicPlayer {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    child_pid: Arc<AtomicU32>,
    thread: Option<std::thread::JoinHandle<()>>,
}

use crate::process_unix::{self, ProcessSignal};

impl MusicPlayer {
    fn start(
        music_id: &str,
        url: &str,
        pcm_tx: crossbeam::Sender<MusicPcm>,
        music_event_tx: mpsc::Sender<MusicEvent>,
        resolved_direct_url: bool,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let paused = Arc::new(AtomicBool::new(false));
        let paused_thread = paused.clone();
        let child_pid = Arc::new(AtomicU32::new(0));
        let child_pid_thread = child_pid.clone();
        let music_id = music_id.to_string();
        let url = url.to_string();

        let thread = std::thread::spawn(move || {
            let attempts = if resolved_direct_url { 1 } else { 2 };
            for attempt_index in 0..attempts {
                let attempt = if attempt_index == 0 {
                    MusicPipelineAttempt::Direct
                } else {
                    MusicPipelineAttempt::Hls
                };
                let pipeline_command =
                    build_music_pipeline_command(&url, resolved_direct_url, attempt);
                let pipeline_started_at = time::Instant::now();
                let child = {
                    let mut cmd = process_unix::shell_command(&pipeline_command);
                    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
                    cmd.spawn()
                };

                let mut child = match child {
                    Ok(child) => child,
                    Err(error) => {
                        let _ = music_event_tx.blocking_send(MusicEvent::Error {
                            music_id: music_id.clone(),
                            code: MusicErrorCode::SpawnFailed,
                            diagnostic: format!("yt-dlp/ffmpeg spawn failed: {error}"),
                        });
                        break;
                    }
                };
                child_pid_thread.store(child.id(), Ordering::SeqCst);
                if paused_thread.load(Ordering::SeqCst) {
                    let _ = process_unix::signal_process_group(child.id(), ProcessSignal::Suspend);
                }

                let stderr_tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
                let mut stderr_thread = child.stderr.take().map(|stderr| {
                    let stderr_tail = stderr_tail.clone();
                    std::thread::spawn(move || {
                        let reader = io::BufReader::new(stderr);
                        for line_result in reader.lines() {
                            let line = match line_result {
                                Ok(value) => value.trim().to_string(),
                                Err(_) => break,
                            };
                            if line.is_empty() {
                                continue;
                            }
                            let mut tail = stderr_tail.lock();
                            if tail.len() >= MUSIC_PIPELINE_STDERR_TAIL_LINES {
                                tail.pop_front();
                            }
                            tail.push_back(process_unix::redact_urls(&line));
                        }
                    })
                });

                let Some(stdout) = child.stdout.take() else {
                    let _ = music_event_tx.blocking_send(MusicEvent::Error {
                        music_id: music_id.clone(),
                        code: MusicErrorCode::MissingStdout,
                        diagnostic: "music pipeline missing stdout".to_string(),
                    });
                    process_unix::terminate_child(&mut child, "music");
                    let _ = child.wait();
                    if let Some(handle) = stderr_thread.take() {
                        let _ = handle.join();
                    }
                    child_pid_thread.store(0, Ordering::SeqCst);
                    break;
                };

                let mut reader = io::BufReader::with_capacity(48_000 * 2, stdout);
                let mut chunk = vec![0u8; 960 * 2];
                let mut first_pcm_reported = false;

                loop {
                    if stop_clone.load(Ordering::Relaxed) {
                        break;
                    }
                    match io::Read::read_exact(&mut reader, &mut chunk) {
                        Ok(()) => {
                            if !first_pcm_reported {
                                first_pcm_reported = true;
                                let startup_ms = pipeline_started_at.elapsed().as_millis() as u64;
                                info!(
                                    attempt = ?attempt,
                                    startup_ms,
                                    resolved_direct_url,
                                    "music pipeline first pcm"
                                );
                                let _ = music_event_tx.blocking_send(MusicEvent::FirstPcm {
                                    music_id: music_id.clone(),
                                    startup_ms,
                                    resolved_direct_url,
                                });
                            }
                            let mut samples = Vec::with_capacity(960);
                            for i in 0..960 {
                                samples.push(i16::from_le_bytes([chunk[i * 2], chunk[i * 2 + 1]]));
                            }
                            if pcm_tx
                                .send(MusicPcm {
                                    music_id: music_id.clone(),
                                    samples,
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                chunk.fill(0);

                process_unix::terminate_child(&mut child, "music");
                let wait_result = child.wait();
                if let Some(handle) = stderr_thread.take() {
                    let _ = handle.join();
                }
                child_pid_thread.store(0, Ordering::SeqCst);

                if stop_clone.load(Ordering::Relaxed) {
                    break;
                }

                let stderr = stderr_tail
                    .lock()
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" || ");
                if wait_result
                    .as_ref()
                    .is_ok_and(std::process::ExitStatus::success)
                    && first_pcm_reported
                {
                    let _ = music_event_tx.blocking_send(MusicEvent::Idle {
                        music_id: music_id.clone(),
                    });
                    break;
                }

                let code = classify_music_pipeline_error(&stderr).unwrap_or_else(|| {
                    if wait_result.is_err() {
                        MusicErrorCode::WaitFailed
                    } else if first_pcm_reported {
                        MusicErrorCode::PipelineFailed
                    } else {
                        MusicErrorCode::NoAudio
                    }
                });
                let stderr_summary = if stderr.is_empty() {
                    String::new()
                } else {
                    format!(" | stderr tail: {stderr}")
                };
                let diagnostic = match wait_result {
                    Ok(status) if status.success() => {
                        format!("music pipeline exited without audio{stderr_summary}")
                    }
                    Ok(status) => {
                        format!("music pipeline exited with status {status}{stderr_summary}")
                    }
                    Err(error) => {
                        format!("music pipeline wait failed: {error}{stderr_summary}")
                    }
                };

                if should_retry_music_pipeline(
                    resolved_direct_url,
                    attempt,
                    first_pcm_reported,
                    code,
                ) {
                    info!(code = ?code, "retrying music pipeline with strict HLS selector");
                    continue;
                }

                let _ = music_event_tx.blocking_send(MusicEvent::Error {
                    music_id: music_id.clone(),
                    code,
                    diagnostic,
                });
                break;
            }
            paused_thread.store(false, Ordering::SeqCst);
        });

        MusicPlayer {
            stop,
            paused,
            child_pid,
            thread: Some(thread),
        }
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.child_pid.load(Ordering::SeqCst) != 0
    }

    #[cfg(test)]
    pub(crate) fn pending_for_test() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
            child_pid: Arc::new(AtomicU32::new(0)),
            thread: None,
        }
    }

    pub(crate) fn pause(&self) -> bool {
        if self.paused.load(Ordering::SeqCst) {
            return true;
        }
        self.paused.store(true, Ordering::SeqCst);
        let pid = self.child_pid.load(Ordering::SeqCst);
        if pid == 0 {
            return true;
        }
        match process_unix::signal_process_group(pid, ProcessSignal::Suspend) {
            Ok(()) => {
                self.paused.store(true, Ordering::SeqCst);
                true
            }
            Err(error) => {
                self.paused.store(true, Ordering::SeqCst);
                if error.kind() != io::ErrorKind::NotFound {
                    warn!(pid, error = %error, "failed to pause music process group");
                }
                false
            }
        }
    }

    pub(crate) fn resume(&self) -> bool {
        let was_paused = self.paused.swap(false, Ordering::SeqCst);
        let pid = self.child_pid.load(Ordering::SeqCst);
        if pid == 0 {
            return true;
        }
        if !was_paused {
            return true;
        }
        match process_unix::signal_process_group(pid, ProcessSignal::Resume) {
            Ok(()) => {
                self.paused.store(false, Ordering::SeqCst);
                true
            }
            Err(error) => {
                self.paused.store(true, Ordering::SeqCst);
                if error.kind() != io::ErrorKind::NotFound {
                    warn!(pid, error = %error, "failed to resume music process group");
                }
                false
            }
        }
    }

    pub(crate) fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let was_paused = self.paused.swap(false, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            if !thread.is_finished() {
                let pid = self.child_pid.load(Ordering::SeqCst);
                // A suspended process won't handle termination until resumed.
                if was_paused {
                    let _ = process_unix::signal_process_group(pid, ProcessSignal::Resume);
                }
                if let Err(error) =
                    process_unix::signal_process_group(pid, ProcessSignal::Terminate)
                    && error.kind() != io::ErrorKind::NotFound
                {
                    warn!(pid, error = %error, "failed to stop music process group");
                }
            }
            if thread.is_finished() {
                let _ = thread.join();
            } else {
                std::thread::spawn(move || {
                    let _ = thread.join();
                });
            }
        }
    }
}

impl Drop for MusicPlayer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Default)]
#[allow(clippy::struct_excessive_bools)] // Music state machine flags are inherently boolean.
pub(crate) struct MusicState {
    pub(crate) player: Option<MusicPlayer>,
    pub(crate) active: bool,
    pub(crate) paused: bool,
    pub(crate) finishing: bool,
    pub(crate) music_id: Option<String>,
    pub(crate) active_url: Option<String>,
    pub(crate) active_resolved_direct_url: bool,
    pub(crate) pending_stop: bool,
    pub(crate) desired_gain: f32,
    pub(crate) first_pcm_seen: bool,
}

impl MusicState {
    pub(crate) fn stop_player(&mut self) {
        if let Some(ref mut player) = self.player {
            player.stop();
        }
        self.player = None;
    }

    pub(crate) fn reset(&mut self) {
        self.stop_player();
        self.active = false;
        self.paused = false;
        self.finishing = false;
        self.music_id = None;
        self.active_url = None;
        self.active_resolved_direct_url = false;
        self.pending_stop = false;
        self.desired_gain = 1.0;
        self.first_pcm_seen = false;
    }

    pub(crate) fn start(&mut self, music_id: String, url: String, resolved_direct_url: bool) {
        self.stop_player();
        self.active = false;
        self.paused = false;
        self.finishing = false;
        self.pending_stop = false;
        self.music_id = Some(music_id);
        self.active_url = Some(url);
        self.active_resolved_direct_url = resolved_direct_url;
        self.desired_gain = 1.0;
        self.first_pcm_seen = false;
    }
}

fn build_music_pipeline_command(
    url: &str,
    resolved_direct_url: bool,
    attempt: MusicPipelineAttempt,
) -> String {
    if resolved_direct_url {
        let quoted_url = process_unix::shell_quote(url);
        format!("ffmpeg -nostdin -loglevel error -i {quoted_url} -f s16le -ar 48000 -ac 1 pipe:1")
    } else {
        let (selector, player_client) = match attempt {
            MusicPipelineAttempt::Direct => (MUSIC_DIRECT_SELECTOR, "web_embedded"),
            MusicPipelineAttempt::Hls => (MUSIC_HLS_SELECTOR, "android"),
        };
        let input = process_unix::ytdlp_resolved_input_with_client(url, selector, player_client);
        format!("ffmpeg -nostdin -loglevel error -i {input} -f s16le -ar 48000 -ac 1 pipe:1")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::Ordering;

    use crossbeam_channel as crossbeam;
    use parking_lot::Mutex;

    use super::{
        MusicPcm, MusicPipelineAttempt, MusicPlayer, build_music_pipeline_command,
        classify_music_pipeline_error, is_music_output_drained, should_retry_music_pipeline,
    };
    use crate::audio_pipeline::AudioSendState;
    use crate::ipc::MusicErrorCode;

    #[test]
    fn music_output_not_drained_while_pcm_queue_has_chunks() {
        let (music_pcm_tx, music_pcm_rx) = crossbeam::bounded::<MusicPcm>(4);
        let audio_send_state = Arc::new(Mutex::new(Some(
            AudioSendState::new().expect("audio state"),
        )));

        music_pcm_tx
            .send(MusicPcm {
                music_id: "music-1".into(),
                samples: vec![0; 960],
            })
            .expect("queue chunk");

        assert!(!is_music_output_drained(&music_pcm_rx, &audio_send_state));
    }

    #[test]
    fn music_output_not_drained_while_mixer_buffer_has_music() {
        let (_music_pcm_tx, music_pcm_rx) = crossbeam::bounded::<MusicPcm>(4);
        let audio_send_state = Arc::new(Mutex::new(Some(
            AudioSendState::new().expect("audio state"),
        )));
        {
            let mut guard = audio_send_state.lock();
            let state = guard.as_mut().expect("state");
            state.push_music_pcm(vec![0; 960]);
        }

        assert!(!is_music_output_drained(&music_pcm_rx, &audio_send_state));
    }

    #[test]
    fn music_output_drained_when_queue_and_mixer_are_empty() {
        let (_music_pcm_tx, music_pcm_rx) = crossbeam::bounded::<MusicPcm>(4);
        let audio_send_state = Arc::new(Mutex::new(Some(
            AudioSendState::new().expect("audio state"),
        )));

        assert!(is_music_output_drained(&music_pcm_rx, &audio_send_state));
    }

    #[test]
    fn direct_music_pipeline_command_skips_ytdlp() {
        let command = build_music_pipeline_command(
            "https://cdn.example.com/audio.m4a",
            true,
            MusicPipelineAttempt::Direct,
        );
        assert!(command.starts_with("ffmpeg "));
        assert!(!command.contains("yt-dlp"));
    }

    #[test]
    fn unresolved_music_pipeline_command_uses_ytdlp() {
        let command = build_music_pipeline_command(
            "https://www.youtube.com/watch?v=abc123",
            false,
            MusicPipelineAttempt::Direct,
        );
        assert!(command.contains("yt-dlp"));
        assert!(command.contains("web_embedded"));
        assert!(command.contains("ba/bestaudio"));
        assert!(command.starts_with("ffmpeg "));
    }

    #[test]
    fn retry_command_uses_strict_hls_selector_without_direct_fallback() {
        let command = build_music_pipeline_command(
            "https://www.youtube.com/watch?v=abc123",
            false,
            MusicPipelineAttempt::Hls,
        );

        assert!(command.contains("protocol^=m3u8"));
        assert!(command.contains("acodec!=none"));
        assert!(!command.contains("ba/bestaudio"));
    }

    #[test]
    fn retry_is_limited_to_classified_failures_before_first_pcm() {
        assert_eq!(
            classify_music_pipeline_error("ERROR: HTTP Error 403: Forbidden"),
            Some(MusicErrorCode::Http403)
        );
        assert_eq!(
            classify_music_pipeline_error("Requested format is not available"),
            Some(MusicErrorCode::FormatUnavailable)
        );
        assert!(should_retry_music_pipeline(
            false,
            MusicPipelineAttempt::Direct,
            false,
            MusicErrorCode::Http403,
        ));
        assert!(!should_retry_music_pipeline(
            false,
            MusicPipelineAttempt::Direct,
            true,
            MusicErrorCode::Http403,
        ));
        assert!(!should_retry_music_pipeline(
            false,
            MusicPipelineAttempt::Hls,
            false,
            MusicErrorCode::FormatUnavailable,
        ));
    }

    #[test]
    fn pause_and_resume_requests_are_retained_before_process_spawn() {
        let player = MusicPlayer::pending_for_test();

        assert!(player.pause());
        assert!(player.paused.load(Ordering::SeqCst));
        assert!(player.resume());
        assert!(!player.paused.load(Ordering::SeqCst));
    }
}
