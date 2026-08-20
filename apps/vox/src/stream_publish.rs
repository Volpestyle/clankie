use std::collections::VecDeque;
use std::io::{self, BufRead, Read, Write};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use crossbeam_channel as crossbeam;
use tracing::{info, warn};

use crate::app_state::AppState;
use crate::ipc::{ErrorCode, InMsg, OutMsg, send_msg, send_transport_error};
use crate::voice_conn::TransportRole;

const STREAM_PUBLISH_STDERR_TAIL_LINES: usize = 24;
pub(crate) const STREAM_PUBLISH_TARGET_FPS: u32 = 30;
const STREAM_PUBLISH_TARGET_WIDTH: u32 = 1280;
const STREAM_PUBLISH_TARGET_HEIGHT: u32 = 720;
const STREAM_PUBLISH_VIDEO_BITRATE_KBPS: u32 = 2_500;
const STREAM_PUBLISH_BROWSER_FRAME_MAX_BYTES: usize = 6 * 1024 * 1024;
const STREAM_PUBLISH_H264_BUFFER_MAX_BYTES: usize = 8 * 1024 * 1024;
const STREAM_PUBLISH_BROWSER_MIME_TYPE: &str = "image/png";
/// Bounded depth of the browser-frame lane into the stdin writer thread.
/// Frames can be up to 6MB each, so keep the queue shallow and drop the
/// oldest frame when the writer falls behind (e.g. ffmpeg stalls).
const STREAM_PUBLISH_BROWSER_FRAME_QUEUE_CAPACITY: usize = 4;

#[derive(Debug, Clone)]
pub(crate) struct StreamPublishFrame {
    pub(crate) access_unit: Vec<u8>,
    pub(crate) timestamp_increment: u32,
    pub(crate) source_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StreamPublishSource {
    Url(String),
    BrowserFrames,
}

#[derive(Debug, Clone)]
pub(crate) enum StreamPublishEvent {
    Idle,
    Error(String),
}

#[derive(Default)]
pub(crate) struct StreamPublishState {
    pub(crate) player: Option<StreamPublishPlayer>,
    pub(crate) pending_source: Option<StreamPublishSource>,
    pub(crate) active_source: Option<StreamPublishSource>,
    pub(crate) active: bool,
    pub(crate) paused: bool,
    source_generation: u64,
    media_started: bool,
}

impl StreamPublishState {
    pub(crate) fn queue_pending_start(&mut self, source: StreamPublishSource) {
        self.pending_source = Some(source);
    }

    pub(crate) fn clear_pending_start(&mut self) {
        self.pending_source = None;
    }

    fn begin_source(&mut self) -> u64 {
        self.source_generation = self.source_generation.wrapping_add(1);
        self.media_started = false;
        self.source_generation
    }

    fn mark_media_started(&mut self, source_generation: u64) -> bool {
        if source_generation != self.source_generation || self.media_started {
            return false;
        }
        self.media_started = true;
        true
    }

    pub(crate) fn reset_media_started(&mut self) {
        self.media_started = false;
    }

    pub(crate) fn stop_player(&mut self) {
        if let Some(player) = self.player.take() {
            player.stop();
        }
    }

    pub(crate) fn reset(&mut self) {
        self.stop_player();
        self.pending_source = None;
        self.active_source = None;
        self.active = false;
        self.paused = false;
        self.media_started = false;
    }
}

/// One browser frame queued for the stdin writer thread.  The timestamp
/// increment travels with the frame so dropped frames never desynchronise
/// the increment queue consumed by the pipeline thread.
struct BrowserFrameInput {
    frame_bytes: Vec<u8>,
    timestamp_increment: u32,
}

enum StreamPublishPlayerMode {
    Url,
    BrowserFrames {
        frame_input_tx: crossbeam::Sender<BrowserFrameInput>,
        /// Receiver clone used only to pop the oldest queued frame when the
        /// lane is full — the writer thread holds its own receiver.
        frame_input_rx: crossbeam::Receiver<BrowserFrameInput>,
        last_captured_at_ms: Arc<AtomicU64>,
        dropped_frames: AtomicU64,
    },
}

pub(crate) struct StreamPublishPlayer {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    child_pid: Arc<AtomicU32>,
    thread: Option<std::thread::JoinHandle<()>>,
    mode: StreamPublishPlayerMode,
}

use crate::process_unix::{self, ProcessSignal};

use crate::h264::find_next_start_code;

fn find_next_aud_start(data: &[u8], from: usize) -> Option<usize> {
    let mut search_from = from;
    while let Some((index, start_code_len)) = find_next_start_code(data, search_from) {
        let nal_start = index + start_code_len;
        if data.get(nal_start).is_some_and(|byte| (byte & 0x1f) == 9) {
            return Some(index);
        }
        search_from = nal_start;
    }
    None
}

fn drain_h264_access_units(buffer: &mut Vec<u8>, flush_tail: bool) -> Vec<Vec<u8>> {
    let Some(first_aud) = find_next_aud_start(buffer, 0) else {
        return Vec::new();
    };
    if first_aud > 0 {
        buffer.drain(..first_aud);
    }

    let mut out = Vec::new();
    while let Some(next_aud) = find_next_aud_start(buffer, 4) {
        if next_aud == 0 {
            break;
        }
        let access_unit = buffer.drain(..next_aud).collect::<Vec<_>>();
        if !access_unit.is_empty() {
            out.push(access_unit);
        }
    }

    if flush_tail && !buffer.is_empty() {
        out.push(std::mem::take(buffer));
    }

    out
}

pub(crate) fn build_stream_publish_pipeline_command(url: &str) -> String {
    let ffmpeg_tail = format!(
        "ffmpeg -nostdin -loglevel error -re -i {{input}} -an -sn -dn -vf \"scale=w={STREAM_PUBLISH_TARGET_WIDTH}:h={STREAM_PUBLISH_TARGET_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,pad={STREAM_PUBLISH_TARGET_WIDTH}:{STREAM_PUBLISH_TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,fps={STREAM_PUBLISH_TARGET_FPS}\" -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -profile:v baseline -level 3.1 -g {STREAM_PUBLISH_TARGET_FPS} -keyint_min {STREAM_PUBLISH_TARGET_FPS} -sc_threshold 0 -b:v {STREAM_PUBLISH_VIDEO_BITRATE_KBPS}k -maxrate {STREAM_PUBLISH_VIDEO_BITRATE_KBPS}k -bufsize {}k -f h264 -bsf:v h264_metadata=aud=insert pipe:1",
        STREAM_PUBLISH_VIDEO_BITRATE_KBPS * 2
    );

    let input = process_unix::ytdlp_resolved_input(
        url,
        "bestvideo[ext=mp4][vcodec*=avc1]/bestvideo[vcodec*=avc1]/bestvideo/best",
    );
    ffmpeg_tail.replace("{input}", &input)
}

pub(crate) fn build_stream_publish_browser_pipeline_command() -> String {
    format!(
        "ffmpeg -nostdin -loglevel error -f image2pipe -codec:v png -framerate {STREAM_PUBLISH_TARGET_FPS} -i pipe:0 -an -sn -dn -vf \"scale=w={STREAM_PUBLISH_TARGET_WIDTH}:h={STREAM_PUBLISH_TARGET_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,pad={STREAM_PUBLISH_TARGET_WIDTH}:{STREAM_PUBLISH_TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black\" -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -profile:v baseline -level 3.1 -g {STREAM_PUBLISH_TARGET_FPS} -keyint_min {STREAM_PUBLISH_TARGET_FPS} -sc_threshold 0 -b:v {STREAM_PUBLISH_VIDEO_BITRATE_KBPS}k -maxrate {STREAM_PUBLISH_VIDEO_BITRATE_KBPS}k -bufsize {}k -f h264 -bsf:v h264_metadata=aud=insert pipe:1",
        STREAM_PUBLISH_VIDEO_BITRATE_KBPS * 2
    )
}

fn is_supported_browser_mime_type(mime_type: &str) -> bool {
    mime_type
        .trim()
        .eq_ignore_ascii_case(STREAM_PUBLISH_BROWSER_MIME_TYPE)
}

fn decode_stream_publish_browser_frame(frame_base64: &str) -> Result<Vec<u8>, String> {
    let normalized = frame_base64.trim();
    if normalized.is_empty() {
        return Err("stream_publish_browser_frame_missing_bytes".to_string());
    }
    let decoded = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, normalized)
        .map_err(|error| format!("stream_publish_browser_frame_invalid_base64: {error}"))?;
    if decoded.is_empty() {
        return Err("stream_publish_browser_frame_empty".to_string());
    }
    if decoded.len() > STREAM_PUBLISH_BROWSER_FRAME_MAX_BYTES {
        return Err(format!(
            "stream_publish_browser_frame_too_large:{}",
            decoded.len()
        ));
    }
    Ok(decoded)
}

fn compute_browser_frame_timestamp_increment(
    last_captured_at_ms: &AtomicU64,
    captured_at_ms: u64,
) -> u32 {
    let default_increment = 90_000 / STREAM_PUBLISH_TARGET_FPS;
    if captured_at_ms == 0 {
        return default_increment;
    }
    let previous = last_captured_at_ms.swap(captured_at_ms, Ordering::SeqCst);
    if previous == 0 || captured_at_ms <= previous {
        return default_increment;
    }
    let delta_ms = captured_at_ms.saturating_sub(previous).clamp(1, 5_000);
    let increment = ((delta_ms as u128) * 90_000u128) / 1_000u128;
    increment
        .clamp(1, u128::from(u32::MAX))
        .try_into()
        .unwrap_or(default_increment)
}

/// Per-pipeline labels woven into the log/event strings emitted by
/// [`run_pipeline`]. Keeping these as fields preserves the byte-for-byte
/// wording each variant emitted before the pump was unified.
struct PipelineLabels {
    /// Inserted into "stream publish {spawn} spawn failed: ...".
    spawn: &'static str,
    /// Inserted into "stream publish {pipeline} missing stdout" and the
    /// exit/wait status messages.
    pipeline: &'static str,
    /// Inserted into "stream publish {read}stdout read failed: ..."; must
    /// carry its own trailing space when non-empty.
    read: &'static str,
}

/// Shared spawn -> stderr-tail -> read-loop -> drain -> emit skeleton used by
/// every H264 stream-publish source. The variant-specific behaviour is passed
/// in: how to build the shell command, whether stdin is piped (and where to
/// stash it), what to log on the first frame, and how to compute each frame's
/// timestamp increment.
fn run_pipeline(
    pipeline_command: String,
    pipe_stdin: bool,
    stdin_slot: Option<Arc<parking_lot::Mutex<Option<std::process::ChildStdin>>>>,
    frame_tx: crossbeam::Sender<StreamPublishFrame>,
    event_tx: crossbeam::Sender<StreamPublishEvent>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    child_pid: Arc<AtomicU32>,
    labels: PipelineLabels,
    source_generation: u64,
    on_first_frame: impl Fn(u64),
    mut timestamp_increment: impl FnMut() -> u32,
) {
    let pipeline_started_at = tokio::time::Instant::now();
    let child = {
        let mut cmd = process_unix::shell_command(&pipeline_command);
        if pipe_stdin {
            cmd.stdin(Stdio::piped());
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.spawn()
    };

    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            let _ = event_tx.send(StreamPublishEvent::Error(format!(
                "stream publish {} spawn failed: {error}",
                labels.spawn
            )));
            return;
        }
    };
    child_pid.store(child.id(), Ordering::SeqCst);
    if let Some(slot) = stdin_slot.as_ref() {
        *slot.lock() = child.stdin.take();
    }

    let stderr_tail = Arc::new(parking_lot::Mutex::new(VecDeque::<String>::new()));
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
                if tail.len() >= STREAM_PUBLISH_STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                tail.push_back(process_unix::redact_urls(&line));
            }
        })
    });

    let Some(mut stdout) = child.stdout.take() else {
        let _ = event_tx.send(StreamPublishEvent::Error(format!(
            "stream publish {} missing stdout",
            labels.pipeline
        )));
        if let Some(slot) = stdin_slot.as_ref() {
            *slot.lock() = None;
        }
        process_unix::terminate_child(&mut child, "stream_publish");
        let _ = child.wait();
        if let Some(handle) = stderr_thread.take() {
            let _ = handle.join();
        }
        child_pid.store(0, Ordering::SeqCst);
        return;
    };

    let mut first_frame_reported = false;
    let mut read_buffer = [0u8; 16 * 1024];
    let mut h264_buffer = Vec::<u8>::with_capacity(256 * 1024);

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }

        match stdout.read(&mut read_buffer) {
            Ok(0) => break,
            Ok(bytes_read) => {
                h264_buffer.extend_from_slice(&read_buffer[..bytes_read]);
                if h264_buffer.len() > STREAM_PUBLISH_H264_BUFFER_MAX_BYTES {
                    let _ = event_tx.send(StreamPublishEvent::Error(
                        "stream publish H264 access unit exceeded the bounded buffer".to_string(),
                    ));
                    break;
                }
                for access_unit in drain_h264_access_units(&mut h264_buffer, false) {
                    if !first_frame_reported {
                        first_frame_reported = true;
                        let startup_ms = pipeline_started_at.elapsed().as_millis() as u64;
                        on_first_frame(startup_ms);
                    }
                    if frame_tx
                        .send(StreamPublishFrame {
                            access_unit,
                            timestamp_increment: timestamp_increment(),
                            source_generation,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
            Err(error) => {
                let _ = event_tx.send(StreamPublishEvent::Error(format!(
                    "stream publish {}stdout read failed: {error}",
                    labels.read
                )));
                break;
            }
        }
    }

    if !stop.load(Ordering::Relaxed) {
        for access_unit in drain_h264_access_units(&mut h264_buffer, true) {
            let _ = frame_tx.send(StreamPublishFrame {
                access_unit,
                timestamp_increment: timestamp_increment(),
                source_generation,
            });
        }
    }

    if let Some(slot) = stdin_slot.as_ref() {
        *slot.lock() = None;
    }
    process_unix::terminate_child(&mut child, "stream_publish");
    let wait_result = child.wait();
    if let Some(handle) = stderr_thread.take() {
        let _ = handle.join();
    }
    child_pid.store(0, Ordering::SeqCst);
    paused.store(false, Ordering::SeqCst);

    let stderr_summary = {
        let tail = stderr_tail.lock();
        if tail.is_empty() {
            String::new()
        } else {
            format!(
                " | stderr tail: {}",
                tail.iter().cloned().collect::<Vec<_>>().join(" || ")
            )
        }
    };

    if !stop.load(Ordering::Relaxed) {
        match wait_result {
            Ok(status) if status.success() => {
                let _ = event_tx.send(StreamPublishEvent::Idle);
            }
            Ok(status) => {
                let _ = event_tx.send(StreamPublishEvent::Error(format!(
                    "stream publish {} exited with status {status}{stderr_summary}",
                    labels.pipeline
                )));
            }
            Err(error) => {
                let _ = event_tx.send(StreamPublishEvent::Error(format!(
                    "stream publish {} wait failed: {error}{stderr_summary}",
                    labels.pipeline
                )));
            }
        }
    }
}

/// Spawn the stdin writer thread for a browser-frame pipeline.
///
/// ffmpeg stdin writes can block indefinitely (e.g. the pipe fills while the
/// pipeline is `SIGSTOP`ped for pause), so they must never run on the event
/// loop.  The writer takes ownership of stdin from the slot on first use;
/// dropping it on exit closes ffmpeg's stdin.
fn spawn_browser_stdin_writer(
    stop: Arc<AtomicBool>,
    stdin_slot: Arc<parking_lot::Mutex<Option<std::process::ChildStdin>>>,
    timestamp_increments: Arc<parking_lot::Mutex<VecDeque<u32>>>,
    frame_rx: crossbeam::Receiver<BrowserFrameInput>,
) {
    std::thread::spawn(move || {
        let mut owned_stdin: Option<std::process::ChildStdin> = None;
        loop {
            let input = match frame_rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(input) => input,
                Err(crossbeam::RecvTimeoutError::Timeout) => {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    continue;
                }
                Err(crossbeam::RecvTimeoutError::Disconnected) => break,
            };
            if stop.load(Ordering::Relaxed) {
                break;
            }
            if owned_stdin.is_none() {
                owned_stdin = stdin_slot.lock().take();
            }
            let Some(writer) = owned_stdin.as_mut() else {
                // ffmpeg not spawned yet (or already gone) — drop the frame.
                continue;
            };
            // Push the increment just before writing so the increment queue
            // only ever contains entries for frames ffmpeg will actually
            // consume.
            timestamp_increments
                .lock()
                .push_back(input.timestamp_increment);
            if let Err(error) = writer
                .write_all(&input.frame_bytes)
                .and_then(|()| writer.flush())
            {
                let _ = timestamp_increments.lock().pop_back();
                warn!(error = %error, "stream publish browser stdin write failed");
                break;
            }
        }
        // Dropping stdin here signals EOF to ffmpeg.
        drop(owned_stdin);
    });
}

impl StreamPublishPlayer {
    pub(crate) fn start_url(
        url: &str,
        source_generation: u64,
        frame_tx: crossbeam::Sender<StreamPublishFrame>,
        event_tx: crossbeam::Sender<StreamPublishEvent>,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let paused = Arc::new(AtomicBool::new(false));
        let paused_thread = paused.clone();
        let child_pid = Arc::new(AtomicU32::new(0));
        let child_pid_thread = child_pid.clone();
        let url = url.to_string();

        let thread = std::thread::spawn(move || {
            let pipeline_command = build_stream_publish_pipeline_command(&url);
            run_pipeline(
                pipeline_command,
                false,
                None,
                frame_tx,
                event_tx,
                stop_clone,
                paused_thread,
                child_pid_thread,
                PipelineLabels {
                    spawn: "yt-dlp/ffmpeg",
                    pipeline: "pipeline",
                    read: "",
                },
                source_generation,
                |startup_ms| {
                    info!(
                        startup_ms,
                        fps = STREAM_PUBLISH_TARGET_FPS,
                        "stream publish produced first video frame"
                    );
                },
                || 90_000 / STREAM_PUBLISH_TARGET_FPS,
            );
        });

        Self {
            stop,
            paused,
            child_pid,
            thread: Some(thread),
            mode: StreamPublishPlayerMode::Url,
        }
    }

    pub(crate) fn start_browser_frames(
        source_generation: u64,
        frame_tx: crossbeam::Sender<StreamPublishFrame>,
        event_tx: crossbeam::Sender<StreamPublishEvent>,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let paused = Arc::new(AtomicBool::new(false));
        let paused_thread = paused.clone();
        let child_pid = Arc::new(AtomicU32::new(0));
        let child_pid_thread = child_pid.clone();
        let stdin = Arc::new(parking_lot::Mutex::new(None));
        let stdin_thread = stdin.clone();
        let timestamp_increments = Arc::new(parking_lot::Mutex::new(VecDeque::<u32>::new()));
        let timestamp_increments_thread = timestamp_increments.clone();
        let last_captured_at_ms = Arc::new(AtomicU64::new(0));
        let (frame_input_tx, frame_input_rx) =
            crossbeam::bounded::<BrowserFrameInput>(STREAM_PUBLISH_BROWSER_FRAME_QUEUE_CAPACITY);

        spawn_browser_stdin_writer(
            stop.clone(),
            stdin.clone(),
            timestamp_increments.clone(),
            frame_input_rx.clone(),
        );

        let thread = std::thread::spawn(move || {
            let pipeline_command = build_stream_publish_browser_pipeline_command();
            run_pipeline(
                pipeline_command,
                true,
                Some(stdin_thread),
                frame_tx,
                event_tx,
                stop_clone,
                paused_thread,
                child_pid_thread,
                PipelineLabels {
                    spawn: "browser ffmpeg",
                    pipeline: "browser pipeline",
                    read: "browser ",
                },
                source_generation,
                |startup_ms| {
                    info!(
                        startup_ms,
                        fps = STREAM_PUBLISH_TARGET_FPS,
                        mime_type = STREAM_PUBLISH_BROWSER_MIME_TYPE,
                        "stream publish produced first browser video frame"
                    );
                },
                move || {
                    timestamp_increments_thread
                        .lock()
                        .pop_front()
                        .unwrap_or(90_000 / STREAM_PUBLISH_TARGET_FPS)
                },
            );
        });

        Self {
            stop,
            paused,
            child_pid,
            thread: Some(thread),
            mode: StreamPublishPlayerMode::BrowserFrames {
                frame_input_tx,
                frame_input_rx,
                last_captured_at_ms,
                dropped_frames: AtomicU64::new(0),
            },
        }
    }

    /// Queue a browser frame for the stdin writer thread.  Never blocks: when
    /// the bounded lane is full the oldest queued frame is dropped so the
    /// stream keeps showing the freshest capture.
    pub(crate) fn push_browser_frame(
        &self,
        frame_bytes: Vec<u8>,
        captured_at_ms: u64,
    ) -> io::Result<()> {
        let StreamPublishPlayerMode::BrowserFrames {
            frame_input_tx,
            frame_input_rx,
            last_captured_at_ms,
            dropped_frames,
        } = &self.mode
        else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "stream publish player is not a browser frame source",
            ));
        };

        if frame_bytes.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "stream publish browser frame was empty",
            ));
        }
        if !self.is_alive() {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stream publish browser pipeline is not running",
            ));
        }

        let timestamp_increment =
            compute_browser_frame_timestamp_increment(last_captured_at_ms, captured_at_ms);
        let mut input = BrowserFrameInput {
            frame_bytes,
            timestamp_increment,
        };
        loop {
            match frame_input_tx.try_send(input) {
                Ok(()) => {
                    let dropped = dropped_frames.swap(0, Ordering::Relaxed);
                    if dropped > 0 {
                        info!(
                            dropped_browser_frames = dropped,
                            "stream publish browser frame backpressure recovered"
                        );
                    }
                    return Ok(());
                }
                Err(crossbeam::TrySendError::Full(returned)) => {
                    // Drop the oldest queued frame and retry with this one.
                    if frame_input_rx.try_recv().is_ok() {
                        let dropped = dropped_frames.fetch_add(1, Ordering::Relaxed) + 1;
                        if dropped == 1 || dropped % 100 == 0 {
                            warn!(
                                dropped_browser_frames = dropped,
                                "dropping oldest stream publish browser frame; stdin writer is behind"
                            );
                        }
                    }
                    input = returned;
                }
                Err(crossbeam::TrySendError::Disconnected(_)) => {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "stream publish browser stdin writer is gone",
                    ));
                }
            }
        }
    }

    pub(crate) fn is_alive(&self) -> bool {
        self.child_pid.load(Ordering::SeqCst) != 0
    }

    pub(crate) fn pause(&self) -> bool {
        if self.paused.load(Ordering::SeqCst) {
            return self.is_alive();
        }
        let pid = self.child_pid.load(Ordering::SeqCst);
        if pid == 0 {
            return false;
        }
        match process_unix::signal_process_group(pid, ProcessSignal::Suspend) {
            Ok(()) => {
                self.paused.store(true, Ordering::SeqCst);
                true
            }
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    warn!(pid, error = %error, "failed to pause stream publish process group");
                }
                false
            }
        }
    }

    pub(crate) fn resume(&self) -> bool {
        if !self.paused.load(Ordering::SeqCst) {
            return self.is_alive();
        }
        let pid = self.child_pid.load(Ordering::SeqCst);
        if pid == 0 {
            return false;
        }
        match process_unix::signal_process_group(pid, ProcessSignal::Resume) {
            Ok(()) => {
                self.paused.store(false, Ordering::SeqCst);
                true
            }
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    warn!(
                        pid,
                        error = %error,
                        "failed to resume stream publish process group"
                    );
                }
                false
            }
        }
    }

    pub(crate) fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let was_paused = self.paused.swap(false, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            if !handle.is_finished() {
                let pid = self.child_pid.load(Ordering::SeqCst);
                // A suspended process won't handle termination until resumed.
                if was_paused {
                    let _ = process_unix::signal_process_group(pid, ProcessSignal::Resume);
                }
                if let Err(error) =
                    process_unix::signal_process_group(pid, ProcessSignal::Terminate)
                    && error.kind() != io::ErrorKind::NotFound
                {
                    warn!(
                        pid,
                        error = %error,
                        "failed to stop stream publish process group"
                    );
                }
            }
            // Never block the event loop on pipeline teardown — join on a
            // detached thread if the pipeline is still winding down.
            if handle.is_finished() {
                let _ = handle.join();
            } else {
                std::thread::spawn(move || {
                    let _ = handle.join();
                });
            }
        }
    }
}

impl AppState {
    fn clear_stream_publish_runtime_buffers(&self) {
        while self.stream_publish_frame_rx.try_recv().is_ok() {}
        while self.stream_publish_event_rx.try_recv().is_ok() {}
    }

    pub(crate) fn stop_stream_publish_runtime(&mut self, reason: &str) {
        if let Some(conn) = self.stream_publish_conn.as_ref() {
            if let Err(error) = conn.set_stream_publish_speaking(false) {
                warn!(reason = reason, error = %error, "failed to disable stream publish speaking");
            }
            if let Err(error) = conn.set_stream_publish_video_active(false) {
                warn!(reason = reason, error = %error, "failed to disable stream publish video state");
            }
        }
        self.stream_publish.stop_player();
        self.clear_stream_publish_runtime_buffers();
        self.stream_publish.active = false;
        self.stream_publish.paused = false;
        self.stream_publish.active_source = None;
        self.stream_publish.media_started = false;
        self.stream_publish_frames_sent = 0;
    }

    pub(crate) fn maybe_start_stream_publish_pipeline(&mut self) {
        if self.stream_publish_conn.is_none()
            || self.stream_publish.active
            || self.stream_publish.paused
        {
            return;
        }
        let Some(source) = self.stream_publish.pending_source.take() else {
            return;
        };

        self.stop_stream_publish_runtime("restart_before_publish_start");
        let source_generation = self.stream_publish.begin_source();

        self.stream_publish.player = Some(match &source {
            StreamPublishSource::Url(url) => StreamPublishPlayer::start_url(
                url,
                source_generation,
                self.stream_publish_frame_tx.clone(),
                self.stream_publish_event_tx.clone(),
            ),
            StreamPublishSource::BrowserFrames => StreamPublishPlayer::start_browser_frames(
                source_generation,
                self.stream_publish_frame_tx.clone(),
                self.stream_publish_event_tx.clone(),
            ),
        });
        self.stream_publish.active = true;
        self.stream_publish.paused = false;

        if let Some(conn) = self.stream_publish_conn.as_ref() {
            if let Err(error) = conn.set_stream_publish_video_active(true) {
                warn!(error = %error, "failed to announce active stream publish video state");
            }
            if let Err(error) = conn.set_stream_publish_speaking(true) {
                warn!(error = %error, "failed to enable stream publish speaking state");
            }
        }
        self.emit_transport_state(TransportRole::StreamPublish, "playing", None);
        match &source {
            StreamPublishSource::Url(_) => info!("started stream publish pipeline"),
            StreamPublishSource::BrowserFrames => {
                info!(
                    mime_type = STREAM_PUBLISH_BROWSER_MIME_TYPE,
                    "started browser stream publish pipeline"
                );
            }
        }
        self.stream_publish.active_source = Some(source);
    }

    pub(crate) fn handle_stream_publish_command(&mut self, msg: InMsg) {
        match msg {
            InMsg::StreamPublishPlay {
                url,
                resolved_direct_url,
            } => {
                let normalized_url = url.trim().to_string();
                if normalized_url.is_empty() {
                    self.emit_transport_state(
                        TransportRole::StreamPublish,
                        "failed",
                        Some("stream_publish_play_missing_url"),
                    );
                    return;
                }
                if resolved_direct_url {
                    self.emit_transport_state(
                        TransportRole::StreamPublish,
                        "failed",
                        Some("stream_publish_play_direct_url_unsupported"),
                    );
                    return;
                }
                let source = StreamPublishSource::Url(normalized_url);
                if self.stream_publish.active
                    && !self.stream_publish.paused
                    && self.stream_publish.active_source.as_ref() == Some(&source)
                {
                    self.emit_transport_state(TransportRole::StreamPublish, "playing", None);
                    return;
                }
                if self.stream_publish.active_source.as_ref() != Some(&source) {
                    self.stop_stream_publish_runtime("stream_publish_source_switch");
                }
                self.stream_publish.queue_pending_start(source);
                if self.stream_publish_conn.is_some() {
                    self.maybe_start_stream_publish_pipeline();
                } else {
                    self.emit_transport_state(
                        TransportRole::StreamPublish,
                        "waiting_for_transport",
                        None,
                    );
                }
            }
            InMsg::StreamPublishBrowserStart { mime_type } => {
                if !is_supported_browser_mime_type(&mime_type) {
                    self.emit_transport_state(
                        TransportRole::StreamPublish,
                        "failed",
                        Some("stream_publish_browser_start_unsupported_mime_type"),
                    );
                    return;
                }
                let source = StreamPublishSource::BrowserFrames;
                if self.stream_publish.active
                    && !self.stream_publish.paused
                    && self.stream_publish.active_source.as_ref() == Some(&source)
                {
                    self.emit_transport_state(TransportRole::StreamPublish, "playing", None);
                    return;
                }
                if self.stream_publish.active_source.as_ref() != Some(&source) {
                    self.stop_stream_publish_runtime("stream_publish_source_switch");
                }
                self.stream_publish.queue_pending_start(source);
                if self.stream_publish_conn.is_some() {
                    self.maybe_start_stream_publish_pipeline();
                } else {
                    self.emit_transport_state(
                        TransportRole::StreamPublish,
                        "waiting_for_transport",
                        None,
                    );
                }
            }
            InMsg::StreamPublishBrowserFrame {
                mime_type,
                frame_base64,
                captured_at_ms,
            } => {
                if !is_supported_browser_mime_type(&mime_type) {
                    self.emit_transport_state(
                        TransportRole::StreamPublish,
                        "failed",
                        Some("stream_publish_browser_frame_unsupported_mime_type"),
                    );
                    return;
                }
                // While paused the ffmpeg process group is SIGSTOPped and
                // consumes nothing — queueing frames would only fill the
                // writer lane with stale captures.  Drop them until resume.
                if self.stream_publish.paused {
                    tracing::debug!("dropping stream publish browser frame while paused");
                    return;
                }
                let frame_bytes = match decode_stream_publish_browser_frame(&frame_base64) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        self.emit_transport_state(
                            TransportRole::StreamPublish,
                            "failed",
                            Some(&error),
                        );
                        return;
                    }
                };

                if self.stream_publish_conn.is_some()
                    && !self.stream_publish.active
                    && matches!(
                        self.stream_publish.pending_source.as_ref(),
                        Some(StreamPublishSource::BrowserFrames)
                    )
                {
                    self.maybe_start_stream_publish_pipeline();
                }

                let Some(player) = self.stream_publish.player.as_ref() else {
                    self.emit_transport_state(
                        TransportRole::StreamPublish,
                        "waiting_for_transport",
                        Some("stream_publish_browser_source_not_started"),
                    );
                    return;
                };
                if !matches!(
                    self.stream_publish.active_source.as_ref(),
                    Some(StreamPublishSource::BrowserFrames)
                ) {
                    self.emit_transport_state(
                        TransportRole::StreamPublish,
                        "failed",
                        Some("stream_publish_browser_frame_source_mismatch"),
                    );
                    return;
                }
                if let Err(error) = player.push_browser_frame(frame_bytes, captured_at_ms) {
                    self.emit_transport_state(
                        TransportRole::StreamPublish,
                        "failed",
                        Some(&format!(
                            "stream_publish_browser_frame_write_failed: {error}"
                        )),
                    );
                }
            }
            InMsg::StreamPublishStop => {
                self.stop_stream_publish_runtime("stream_publish_stop");
                self.stream_publish.clear_pending_start();
                self.emit_transport_state(
                    TransportRole::StreamPublish,
                    "ready",
                    Some("stream_publish_stopped"),
                );
            }
            InMsg::StreamPublishPause => {
                self.stream_publish.paused = true;
                if let Some(player) = self.stream_publish.player.as_ref()
                    && !player.pause()
                {
                    warn!("failed to pause stream publish player");
                }
                if let Some(conn) = self.stream_publish_conn.as_ref() {
                    if let Err(error) = conn.set_stream_publish_speaking(false) {
                        warn!(error = %error, "failed to disable stream publish speaking on pause");
                    }
                    if let Err(error) = conn.set_stream_publish_video_active(false) {
                        warn!(error = %error, "failed to disable stream publish video state on pause");
                    }
                }
                self.emit_transport_state(TransportRole::StreamPublish, "paused", None);
            }
            InMsg::StreamPublishResume => {
                self.stream_publish.paused = false;
                if let Some(player) = self.stream_publish.player.as_ref()
                    && player.resume()
                {
                    if let Some(conn) = self.stream_publish_conn.as_ref() {
                        if let Err(error) = conn.set_stream_publish_video_active(true) {
                            warn!(error = %error, "failed to enable stream publish video state on resume");
                        }
                        if let Err(error) = conn.set_stream_publish_speaking(true) {
                            warn!(error = %error, "failed to enable stream publish speaking on resume");
                        }
                    }
                    self.emit_transport_state(TransportRole::StreamPublish, "playing", None);
                    return;
                }
                if let Some(active_source) = self.stream_publish.active_source.clone() {
                    self.stream_publish.queue_pending_start(active_source);
                    self.stream_publish.active = false;
                    self.stream_publish.active_source = None;
                }
                self.maybe_start_stream_publish_pipeline();
            }
            _ => unreachable!("non-publish IPC command routed to stream publish supervisor"),
        }
    }

    fn handle_stream_publish_event(&mut self, event: StreamPublishEvent) {
        match event {
            StreamPublishEvent::Idle => {
                self.stop_stream_publish_runtime("stream_publish_idle");
                self.emit_transport_state(
                    TransportRole::StreamPublish,
                    "ready",
                    Some("stream_publish_idle"),
                );
            }
            StreamPublishEvent::Error(message) => {
                self.stop_stream_publish_runtime("stream_publish_error");
                self.emit_transport_state(TransportRole::StreamPublish, "failed", Some(&message));
            }
        }
    }

    pub(crate) fn drain_stream_publish_runtime_events(&mut self) {
        while let Ok(event) = self.stream_publish_event_rx.try_recv() {
            self.handle_stream_publish_event(event);
        }
    }

    pub(crate) async fn send_pending_stream_publish_frame(&mut self) {
        if !self.stream_publish.active || self.stream_publish.paused {
            return;
        }

        // Drain all available frames this tick rather than just one.
        // ffmpeg with -re paces output at ~30fps, but read() can deliver
        // multiple access units in a single stdout chunk.  Sending only
        // one per 20ms tick can fall behind, causing the viewer to see a
        // choppy slideshow as frames queue up with stale RTP timestamps.
        //
        // Cap at 4 frames per tick to avoid monopolising the event loop
        // if the queue is deeply backed up (e.g. after unpause).
        const MAX_FRAMES_PER_TICK: usize = 4;
        let mut frames_this_tick = 0;

        while let Ok(frame) = self.stream_publish_frame_rx.try_recv() {
            if frame.source_generation != self.stream_publish.source_generation {
                continue;
            }
            frames_this_tick += 1;
            self.stream_publish_frames_sent += 1;
            let queue_depth = self.stream_publish_frame_rx.len();
            if self.stream_publish_frames_sent <= 5
                || self.stream_publish_frames_sent.is_multiple_of(150)
                || queue_depth > 10
            {
                info!(
                    frame_number = self.stream_publish_frames_sent,
                    frame_bytes = frame.access_unit.len(),
                    queue_depth,
                    frames_this_tick,
                    timestamp_increment = frame.timestamp_increment,
                    "clankvox_stream_publish_frame_sent"
                );
            }

            let StreamPublishFrame {
                access_unit,
                timestamp_increment,
                source_generation,
            } = frame;
            let encrypted_frame = {
                let mut guard = self.stream_publish_dave.lock();
                match *guard {
                    Some(ref mut dave_manager) if dave_manager.is_ready() => {
                        match dave_manager.encrypt_video(&access_unit) {
                            Ok(encrypted) => Some(encrypted),
                            Err(error) => {
                                // Fail closed: with a ready DAVE session, a frame
                                // that cannot be encrypted must never leave as
                                // plaintext — drop it instead.
                                self.stream_publish_encrypt_failures =
                                    self.stream_publish_encrypt_failures.saturating_add(1);
                                let failures = self.stream_publish_encrypt_failures;
                                if failures == 1 || failures.is_multiple_of(100) {
                                    warn!(
                                        consecutive_failures = failures,
                                        error = %error,
                                        "stream publish DAVE encrypt failed; dropping video frame"
                                    );
                                }
                                if failures
                                    == crate::app_state::DAVE_ENCRYPT_FAILURE_ALERT_THRESHOLD
                                {
                                    send_transport_error(
                                        ErrorCode::VoiceRuntimeError,
                                        TransportRole::StreamPublish,
                                        None,
                                        format!(
                                            "stream publish DAVE encrypt failed {failures} times in a row; dropping outbound video"
                                        ),
                                    );
                                }
                                None
                            }
                        }
                    }
                    _ => {
                        if self.stream_publish_frames_sent <= 3 {
                            warn!(
                                frame_number = self.stream_publish_frames_sent,
                                "stream publish frame sent without DAVE (not ready)"
                            );
                        }
                        // DAVE absent or still handshaking — plaintext is the
                        // protocol-correct output in this window.
                        Some(access_unit)
                    }
                }
            };

            let mut frame_transmitted = false;
            if let Some(encrypted_frame) = encrypted_frame {
                self.stream_publish_encrypt_failures = 0;
                if let Some(conn) = self.stream_publish_conn.as_ref() {
                    match conn
                        .send_h264_frame(&encrypted_frame, timestamp_increment)
                        .await
                    {
                        Ok(()) => frame_transmitted = true,
                        Err(error) => {
                            warn!(error = %error, "failed to send stream publish video frame");
                        }
                    }
                }
            }
            if frame_transmitted && self.stream_publish.mark_media_started(source_generation) {
                send_msg(OutMsg::StreamPublishMediaStarted {
                    role: TransportRole::StreamPublish,
                    connection_generation: self
                        .current_transport_generation(TransportRole::StreamPublish),
                    source_generation,
                });
            }

            if frames_this_tick >= MAX_FRAMES_PER_TICK {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        STREAM_PUBLISH_TARGET_FPS, StreamPublishState,
        build_stream_publish_browser_pipeline_command, build_stream_publish_pipeline_command,
        drain_h264_access_units,
    };

    #[test]
    fn build_stream_publish_pipeline_command_uses_ytdlp() {
        let command =
            build_stream_publish_pipeline_command("https://www.youtube.com/watch?v=abc123");
        assert!(command.contains("yt-dlp"));
        assert!(command.contains(&format!("fps={STREAM_PUBLISH_TARGET_FPS}")));
        assert!(command.contains("h264_metadata=aud=insert"));
    }

    #[test]
    fn build_stream_publish_browser_pipeline_command_uses_image2pipe_png_input() {
        let command = build_stream_publish_browser_pipeline_command();
        assert!(command.contains("-f image2pipe"));
        assert!(command.contains("-codec:v png"));
        assert!(command.contains("h264_metadata=aud=insert"));
    }

    #[test]
    fn drain_h264_access_units_splits_on_aud_boundaries() {
        let mut buffer = vec![
            0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x01, 0x02, 0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0,
            1, 0x65, 0xaa,
        ];
        let frames = drain_h264_access_units(&mut buffer, false);
        assert_eq!(frames.len(), 1);
        assert!(frames[0].starts_with(&[0, 0, 0, 1, 0x09]));
        assert!(buffer.starts_with(&[0, 0, 0, 1, 0x09]));
    }

    #[test]
    fn media_started_is_once_per_source_and_rejects_stale_source_generations() {
        let mut state = StreamPublishState::default();
        let first = state.begin_source();
        assert!(state.mark_media_started(first));
        assert!(!state.mark_media_started(first));
        state.reset_media_started();
        assert!(state.mark_media_started(first));

        let replacement = state.begin_source();
        assert_ne!(replacement, first);
        assert!(!state.mark_media_started(first));
        assert!(state.mark_media_started(replacement));
    }
}
