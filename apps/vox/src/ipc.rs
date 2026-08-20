use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use crossbeam_channel as crossbeam;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::app_state::transport_stats;
use crate::voice_conn::TransportRole;

// Bump with packages/vox-client/src/index.ts; no compatibility protocol exists.
pub const IPC_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug)]
struct IpcSenders {
    control_tx: crossbeam::Sender<OutMsg>,
    audio_tx: crossbeam::Sender<OutMsg>,
    video_tx: crossbeam::Sender<OutMsg>,
}

static IPC_TX: std::sync::OnceLock<IpcSenders> = std::sync::OnceLock::new();
static DROPPED_OUTBOUND_VIDEO_FRAMES: AtomicU64 = AtomicU64::new(0);
const MAX_STDIN_LINE_BYTES: usize = 8 * 1_024 * 1_024;
/// Control messages are must-deliver, but the lane is bounded so a stalled
/// parent backpressures producers instead of growing the process unbounded.
const CONTROL_LANE_CAPACITY: usize = 4096;
#[derive(Deserialize, Debug)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum InMsg {
    Join {
        connection_id: String,
        guild_id: String,
        channel_id: String,
        #[serde(default)]
        self_mute: bool,
    },
    Leave {
        #[serde(default)]
        reason: Option<String>,
    },
    VoiceServer {
        data: VoiceServerData,
    },
    VoiceState {
        data: VoiceStateData,
    },
    StreamWatchConnect {
        endpoint: String,
        token: String,
        server_id: String,
        session_id: String,
        user_id: String,
        dave_channel_id: String,
    },
    StreamWatchDisconnect {
        #[serde(default)]
        reason: Option<String>,
    },
    StreamPublishConnect {
        endpoint: String,
        token: String,
        server_id: String,
        session_id: String,
        user_id: String,
        dave_channel_id: String,
    },
    StreamPublishDisconnect {
        #[serde(default)]
        reason: Option<String>,
    },
    Audio {
        playback_id: String,
        pcm_base64: String,
        #[serde(default = "default_sample_rate")]
        sample_rate: u32,
    },
    StopPlayback,
    FinishTtsPlayback {
        playback_id: String,
    },
    StopTtsPlayback {
        playback_id: String,
    },
    SubscribeUser {
        user_id: String,
        capture_id: String,
        #[serde(default = "default_silence_duration")]
        silence_duration_ms: u32,
        #[serde(default = "default_sample_rate")]
        sample_rate: u32,
    },
    UnsubscribeUser {
        user_id: String,
    },
    SubscribeUserVideo {
        user_id: String,
        #[serde(default = "default_video_max_frames_per_second")]
        max_frames_per_second: u32,
        #[serde(default = "default_video_quality")]
        preferred_quality: u32,
        preferred_pixel_count: Option<u32>,
        preferred_stream_type: Option<String>,
        jpeg_quality: Option<u32>,
    },
    UnsubscribeUserVideo {
        user_id: String,
    },
    MusicPlay {
        music_id: String,
        url: String,
        #[serde(default)]
        resolved_direct_url: bool,
    },
    MusicStop {
        music_id: String,
    },
    MusicPause {
        music_id: String,
    },
    MusicResume {
        music_id: String,
    },
    MusicSetGain {
        music_id: String,
        target: f32,
        #[serde(default)]
        fade_ms: u32,
    },
    StreamPublishPlay {
        url: String,
        #[serde(default)]
        resolved_direct_url: bool,
    },
    StreamPublishBrowserStart {
        mime_type: String,
    },
    StreamPublishBrowserFrame {
        mime_type: String,
        frame_base64: String,
        #[serde(default)]
        captured_at_ms: u64,
    },
    StreamPublishStop,
    StreamPublishPause,
    StreamPublishResume,
    Destroy,
}

pub fn default_sample_rate() -> u32 {
    24000
}

pub fn default_silence_duration() -> u32 {
    700
}

pub fn default_video_max_frames_per_second() -> u32 {
    2
}

pub fn default_video_quality() -> u32 {
    100
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    InvalidJson,
    InputTooLarge,
    VoiceConnectFailed,
    StreamWatchConnectFailed,
    StreamPublishConnectFailed,
    VoiceRuntimeError,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DaveStateStatus {
    Negotiating,
    Ready,
    Disabled,
    Cleared,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TtsPlaybackStatus {
    Buffered,
    Started,
    Drained,
    Stopped,
    Failed,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MusicErrorCode {
    Http403,
    FormatUnavailable,
    SpawnFailed,
    MissingStdout,
    NoAudio,
    PipelineFailed,
    WaitFailed,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransportStatsSnapshot {
    pub uptime_ms: u64,
    pub tick: TickStats,
    pub ipc_lanes: IpcLaneStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inbound_audio: Option<InboundAudioStats>,
    pub inbound_video: InboundVideoStats,
    pub outbound: OutboundStats,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TickStats {
    pub total: u64,
    pub skipped: u64,
    pub slip_events: u64,
    pub max_gap_ms: f64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IpcLaneStats {
    pub control_dropped: u64,
    pub audio_dropped: u64,
    pub video_dropped: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InboundAudioStats {
    pub packets: u64,
    pub transport_decrypt_fail: u64,
    pub dave_decrypt_fail: u64,
    pub forward_loss_gaps: u64,
    pub concealed_frames: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InboundVideoStats {
    pub frames_emitted: u64,
    pub decode_dropped: u64,
    pub dave_decrypt_ok: u64,
    pub dave_decrypt_fail: u64,
    pub dave_passthrough: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutboundStats {
    pub rtp_audio_sent: u64,
    pub dave_encrypt_fail: u64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum OutMsg {
    ProcessReady {
        protocol_version: u32,
    },
    Ready {
        connection_id: String,
    },
    AdapterSend {
        payload: Value,
    },
    ConnectionState {
        status: String,
        connection_id: String,
    },
    TransportState {
        role: TransportRole,
        #[serde(skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    DaveState {
        role: TransportRole,
        #[serde(skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
        status: DaveStateStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        protocol_version: Option<u16>,
    },
    PlayerState {
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        music_id: Option<String>,
    },
    PlaybackArmed {
        reason: String,
    },
    TtsPlaybackState {
        playback_id: String,
        status: TtsPlaybackStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    SpeakingStart {
        user_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        capture_id: Option<String>,
    },
    SpeakingEnd {
        user_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        capture_id: Option<String>,
    },
    UserAudio {
        user_id: String,
        capture_id: String,
        #[serde(skip)]
        pcm: Vec<u8>,
        #[serde(skip)]
        signal_peak_abs: u16,
        #[serde(skip)]
        signal_active_sample_count: usize,
        #[serde(skip)]
        signal_sample_count: usize,
    },
    UserAudioEnd {
        user_id: String,
        capture_id: String,
    },
    UserVideoFrame {
        role: TransportRole,
        user_id: String,
        ssrc: u32,
        codec: String,
        keyframe: bool,
        frame_base64: String,
        rtp_timestamp: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        stream_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rid: Option<String>,
        dave_decrypted: bool,
    },
    /// Pre-decoded video frame (JPEG) from the persistent H264 decoder.
    /// The TS side can ingest this directly without spawning ffmpeg.
    DecodedVideoFrame {
        role: TransportRole,
        user_id: String,
        width: u32,
        height: u32,
        jpeg_base64: String,
    },
    ClientDisconnect {
        user_id: String,
    },
    MusicIdle {
        music_id: String,
    },
    MusicError {
        music_id: String,
        code: MusicErrorCode,
        message: String,
    },
    MusicGainReached {
        music_id: String,
        gain: f32,
    },
    Error {
        code: ErrorCode,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<TransportRole>,
        #[serde(skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
    },
    BufferDepth {
        tts_samples: usize,
        music_samples: usize,
    },
    TransportStats(TransportStatsSnapshot),
    TtsBufferOverflow {
        playback_id: String,
        dropped_samples: usize,
        dropped_ms: f64,
        buffer_samples: usize,
        buffer_ms: f64,
    },
    StreamPublishMediaStarted {
        role: TransportRole,
        connection_generation: u64,
        source_generation: u64,
    },
}

#[derive(Deserialize, Debug, Clone)]
pub struct VoiceServerData {
    pub endpoint: Option<String>,
    pub token: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(clippy::option_option)] // The outer option is omitted; the inner option is explicit null.
pub struct VoiceStateData {
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    pub session_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    pub user_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    pub channel_id: Option<Option<String>>,
}

#[allow(clippy::option_option)]
fn deserialize_present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

fn encode_user_audio_payload(
    user_id: &str,
    capture_id: &str,
    pcm: &[u8],
    signal_peak_abs: u16,
    signal_active_sample_count: usize,
    signal_sample_count: usize,
) -> Option<Vec<u8>> {
    let uid = match user_id.parse::<u64>() {
        Ok(uid) => uid,
        Err(err) => {
            warn!(user_id, error = %err, "dropping user audio IPC with non-numeric user id");
            return None;
        }
    };

    let Ok(active_sample_count) = u32::try_from(signal_active_sample_count) else {
        warn!(
            user_id,
            signal_active_sample_count,
            "dropping user audio IPC with oversized active sample count"
        );
        return None;
    };

    let Ok(sample_count) = u32::try_from(signal_sample_count) else {
        warn!(
            user_id,
            signal_sample_count, "dropping user audio IPC with oversized sample count"
        );
        return None;
    };

    let capture_id_bytes = capture_id.as_bytes();
    let Ok(capture_id_len) = u16::try_from(capture_id_bytes.len()) else {
        warn!(
            user_id,
            capture_id_bytes = capture_id_bytes.len(),
            "dropping user audio IPC with oversized capture id"
        );
        return None;
    };

    let mut payload = Vec::with_capacity(8 + 2 + 4 + 4 + 2 + capture_id_bytes.len() + pcm.len());
    payload.extend_from_slice(&uid.to_le_bytes());
    payload.extend_from_slice(&signal_peak_abs.to_le_bytes());
    payload.extend_from_slice(&active_sample_count.to_le_bytes());
    payload.extend_from_slice(&sample_count.to_le_bytes());
    payload.extend_from_slice(&capture_id_len.to_le_bytes());
    payload.extend_from_slice(capture_id_bytes);
    payload.extend_from_slice(pcm);
    Some(payload)
}

pub fn send_msg(mut msg: OutMsg) {
    let Some(tx) = IPC_TX.get() else {
        wipe_user_audio_message(&mut msg);
        return;
    };
    if is_ordered_audio_message(&msg) {
        // Capture PCM and its terminal marker are one reliable FIFO. A
        // stalled parent backpressures capture instead of truncating it or
        // allowing user_audio_end to overtake the final PCM frame.
        if send_ordered_audio_message(&tx.audio_tx, msg).is_some() {
            error!("failed to send ordered audio IPC message: channel disconnected");
        }
        return;
    }
    match msg {
        OutMsg::UserVideoFrame { .. } | OutMsg::DecodedVideoFrame { .. } => {
            match tx.video_tx.try_send(msg) {
                Ok(()) => {
                    let dropped = DROPPED_OUTBOUND_VIDEO_FRAMES.swap(0, Ordering::Relaxed);
                    if dropped > 0 {
                        info!(
                            dropped_video_frames = dropped,
                            "clankvox_outbound_video_backpressure_recovered"
                        );
                    }
                }
                Err(crossbeam::TrySendError::Full(returned)) => {
                    transport_stats()
                        .ipc_video_dropped
                        .fetch_add(1, Ordering::Relaxed);
                    let dropped = DROPPED_OUTBOUND_VIDEO_FRAMES.fetch_add(1, Ordering::Relaxed) + 1;
                    if dropped == 1 || dropped.is_multiple_of(100) {
                        let user_id = match &returned {
                            OutMsg::UserVideoFrame { user_id, .. }
                            | OutMsg::DecodedVideoFrame { user_id, .. } => user_id.as_str(),
                            _ => "",
                        };
                        warn!(
                            user_id,
                            dropped_video_frames = dropped,
                            "dropping outbound clankvox video IPC due to backpressure"
                        );
                    }
                }
                Err(crossbeam::TrySendError::Disconnected(_)) => {
                    error!("failed to send lossy video IPC message: channel disconnected");
                }
            }
        }
        _ => {
            if let Err(err) = tx.control_tx.send(msg) {
                error!("failed to send reliable control IPC message: {}", err);
            }
        }
    }
}

fn is_ordered_audio_message(msg: &OutMsg) -> bool {
    matches!(msg, OutMsg::UserAudio { .. } | OutMsg::UserAudioEnd { .. })
}

fn wipe_user_audio_message(msg: &mut OutMsg) {
    if let OutMsg::UserAudio { pcm, .. } = msg {
        pcm.fill(0);
    }
}

fn send_ordered_audio_message(tx: &crossbeam::Sender<OutMsg>, msg: OutMsg) -> Option<Box<OutMsg>> {
    tx.send(msg).err().map(|error| {
        let mut returned = Box::new(error.0);
        wipe_user_audio_message(&mut returned);
        returned
    })
}

pub fn send_error(code: ErrorCode, message: impl Into<String>) {
    send_msg(OutMsg::Error {
        code,
        message: message.into(),
        role: None,
        connection_id: None,
    });
}

pub fn send_transport_error(
    code: ErrorCode,
    role: TransportRole,
    connection_id: Option<&str>,
    message: impl Into<String>,
) {
    send_msg(OutMsg::Error {
        code,
        message: message.into(),
        role: Some(role),
        connection_id: connection_id.map(ToString::to_string),
    });
}

fn send_reader_error(code: ErrorCode, message: impl Into<String>) {
    if let Some(tx) = IPC_TX.get() {
        let msg = OutMsg::Error {
            code,
            message: message.into(),
            role: None,
            connection_id: None,
        };
        if let Err(err) = tx.control_tx.send(msg) {
            error!("failed to enqueue IPC reader error: {}", err);
        }
    }
}

pub fn send_tts_playback_state(playback_id: &str, status: TtsPlaybackStatus, reason: Option<&str>) {
    info!(
        playback_id,
        status = ?status,
        reason,
        "clankvox_tts_playback_state"
    );
    send_msg(OutMsg::TtsPlaybackState {
        playback_id: playback_id.to_string(),
        status,
        reason: reason.map(ToString::to_string),
    });
}

pub fn send_buffer_depth(tts_samples: usize, music_samples: usize, reason: &str) {
    // High-frequency reasons (every 20ms tick / every inbound TTS chunk)
    // log at debug; state-transition reasons stay at info.
    if matches!(
        reason,
        "periodic_nonempty" | "periodic_drained" | "tts_pcm_enqueued"
    ) {
        debug!(
            tts_samples = tts_samples,
            music_samples = music_samples,
            reason = reason,
            "clankvox_buffer_depth"
        );
    } else {
        info!(
            tts_samples = tts_samples,
            music_samples = music_samples,
            reason = reason,
            "clankvox_buffer_depth"
        );
    }
    send_msg(OutMsg::BufferDepth {
        tts_samples,
        music_samples,
    });
}

pub fn send_transport_stats(snapshot: TransportStatsSnapshot, reason: &str) {
    debug!(
        uptime_ms = snapshot.uptime_ms,
        tick_total = snapshot.tick.total,
        tick_skipped = snapshot.tick.skipped,
        reason = reason,
        "clankvox_transport_stats"
    );
    send_msg(OutMsg::TransportStats(snapshot));
}

pub fn send_gateway_voice_state_update(guild_id: u64, channel_id: u64, self_mute: bool) {
    send_msg(OutMsg::AdapterSend {
        payload: gateway_voice_state_payload(guild_id, Some(channel_id), self_mute),
    });
}

pub fn send_gateway_voice_leave(guild_id: u64, self_mute: bool) {
    send_msg(OutMsg::AdapterSend {
        payload: gateway_voice_state_payload(guild_id, None, self_mute),
    });
}

fn gateway_voice_state_payload(guild_id: u64, channel_id: Option<u64>, self_mute: bool) -> Value {
    serde_json::json!({
        "op": 4,
        "d": {
            "guild_id": guild_id.to_string(),
            "channel_id": channel_id.map(|channel_id| channel_id.to_string()),
            "self_mute": self_mute,
            "self_deaf": false,
        }
    })
}

/// Outcome of reading one newline-delimited stdin line with a size cap.
#[derive(Debug, PartialEq, Eq)]
enum CappedLine {
    /// Stream ended with no pending bytes.
    Eof,
    /// A complete line (without the trailing newline) is in the buffer.
    Line,
    /// The line exceeded the cap; its bytes were discarded up to the next
    /// newline (or EOF) and the reader can continue with the next line.
    TooLong,
}

/// Read one `\n`-terminated line into `buf`, capping memory at `max_len`
/// bytes.  Unlike `BufRead::read_line`, this never buffers an oversized line
/// before rejecting it and never fails on invalid UTF-8 — the caller decides
/// how to interpret the raw bytes.
fn read_line_capped(
    reader: &mut impl BufRead,
    buf: &mut Vec<u8>,
    max_len: usize,
) -> io::Result<CappedLine> {
    buf.clear();
    let mut overflowed = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        if available.is_empty() {
            // EOF — treat pending bytes as a final unterminated line.
            return Ok(if overflowed {
                CappedLine::TooLong
            } else if buf.is_empty() {
                CappedLine::Eof
            } else {
                CappedLine::Line
            });
        }

        let newline_pos = available.iter().position(|&byte| byte == b'\n');
        let chunk_len = newline_pos.unwrap_or(available.len());

        if !overflowed {
            if buf.len() + chunk_len > max_len {
                overflowed = true;
                buf.clear();
            } else {
                buf.extend_from_slice(&available[..chunk_len]);
            }
        }

        if let Some(pos) = newline_pos {
            reader.consume(pos + 1);
            return Ok(if overflowed {
                CappedLine::TooLong
            } else {
                CappedLine::Line
            });
        }
        let consumed = available.len();
        reader.consume(consumed);
    }
}

/// Parse one raw stdin line into an [`InMsg`].  Invalid UTF-8, blank lines,
/// and malformed JSON are all skippable: they report an IPC error (where
/// applicable) and return `None` so the reader moves on to the next line.
fn parse_stdin_line(line: &[u8]) -> Option<InMsg> {
    let Ok(text) = std::str::from_utf8(line) else {
        send_reader_error(
            ErrorCode::InvalidJson,
            format!(
                "Dropped stdin line with invalid UTF-8 ({} bytes)",
                line.len()
            ),
        );
        return None;
    };

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    match serde_json::from_str::<InMsg>(trimmed) {
        Ok(msg) => Some(msg),
        Err(err) => {
            send_reader_error(
                ErrorCode::InvalidJson,
                format!("Invalid stdin JSON message: {err}"),
            );
            None
        }
    }
}

pub struct InboundIpc {
    rx: mpsc::Receiver<InMsg>,
}

impl InboundIpc {
    pub async fn recv(&mut self) -> Option<InMsg> {
        self.rx.recv().await
    }
}

pub fn spawn_ipc_reader() -> InboundIpc {
    let (tx, rx) = mpsc::channel::<InMsg>(256);

    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut handle = stdin.lock();
        let mut line_buf: Vec<u8> = Vec::new();

        loop {
            match read_line_capped(&mut handle, &mut line_buf, MAX_STDIN_LINE_BYTES) {
                Ok(CappedLine::Eof) => break,
                Ok(CappedLine::TooLong) => {
                    send_reader_error(
                        ErrorCode::InputTooLarge,
                        format!("Dropped oversized stdin line (> {MAX_STDIN_LINE_BYTES} bytes)"),
                    );
                }
                Ok(CappedLine::Line) => {
                    let Some(msg) = parse_stdin_line(&line_buf) else {
                        continue;
                    };
                    // One bounded lane preserves stdin order. In particular,
                    // finish_tts_playback cannot overtake preceding PCM.
                    if tx.blocking_send(msg).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    warn!(error = %err, "stdin reader exiting after read error");
                    break;
                }
            }
        }

        let _ = tx.blocking_send(InMsg::Destroy);
    });

    InboundIpc { rx }
}

fn write_framed(out: &mut impl Write, format: u8, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "IPC frame exceeds u32"))?;
    out.write_all(&[format])?;
    out.write_all(&len.to_le_bytes())?;
    out.write_all(payload)?;
    out.flush()
}

pub fn spawn_ipc_writer() {
    if IPC_TX.get().is_some() {
        return;
    }

    let (control_tx, control_rx) = crossbeam::bounded::<OutMsg>(CONTROL_LANE_CAPACITY);
    let (audio_tx, audio_rx) = crossbeam::bounded::<OutMsg>(512);
    let (video_tx, video_rx) = crossbeam::bounded::<OutMsg>(64);
    std::thread::spawn(move || {
        let mut out = io::stdout().lock();
        loop {
            // Writer priority: control > audio > video.
            let msg = if let Ok(msg) = control_rx.try_recv() {
                msg
            } else if let Ok(msg) = audio_rx.try_recv() {
                msg
            } else if let Ok(msg) = video_rx.try_recv() {
                msg
            } else {
                crossbeam::select! {
                    recv(control_rx) -> msg => match msg {
                        Ok(msg) => msg,
                        Err(_) => break,
                    },
                    recv(audio_rx) -> msg => match msg {
                        Ok(msg) => msg,
                        Err(_) => break,
                    },
                    recv(video_rx) -> msg => match msg {
                        Ok(msg) => msg,
                        Err(_) => break,
                    },
                }
            };

            match msg {
                OutMsg::UserAudio {
                    user_id,
                    capture_id,
                    mut pcm,
                    signal_peak_abs,
                    signal_active_sample_count,
                    signal_sample_count,
                } => {
                    let payload = encode_user_audio_payload(
                        &user_id,
                        &capture_id,
                        &pcm,
                        signal_peak_abs,
                        signal_active_sample_count,
                        signal_sample_count,
                    );
                    pcm.fill(0);
                    let Some(mut payload) = payload else {
                        continue;
                    };

                    let write_result = write_framed(&mut out, 1, &payload);
                    payload.fill(0);
                    if let Err(e) = write_result {
                        // Stdout broken — parent process likely exited. Audio frames
                        // are lossy so we just log once and let the reader thread
                        // detect stdin EOF to trigger a clean shutdown.
                        error!("IPC stdout write failed (audio): {e}");
                        break;
                    }
                }
                other => {
                    if let Ok(json) = serde_json::to_string(&other)
                        && let Err(e) = write_framed(&mut out, 0, json.as_bytes())
                    {
                        error!("IPC stdout write failed (control): {e}");
                        break;
                    }
                }
            }
        }
    });

    let senders = IpcSenders {
        control_tx,
        audio_tx,
        video_tx,
    };
    IPC_TX.set(senders).expect("IPC_TX already initialized");
}

#[cfg(test)]
mod tests {
    use super::{
        CappedLine, DaveStateStatus, IPC_PROTOCOL_VERSION, InMsg, InboundAudioStats,
        InboundVideoStats, IpcLaneStats, OutMsg, OutboundStats, TickStats, TransportStatsSnapshot,
        TtsPlaybackStatus, encode_user_audio_payload, gateway_voice_state_payload,
        is_ordered_audio_message, parse_stdin_line, read_line_capped, send_ordered_audio_message,
        wipe_user_audio_message, write_framed,
    };

    #[test]
    fn encode_user_audio_payload_serializes_header_fields() {
        let payload =
            encode_user_audio_payload("42", "capture-7", &[1, 2, 3, 4], 7, 8, 2).expect("payload");

        assert_eq!(&payload[0..8], &42_u64.to_le_bytes());
        assert_eq!(&payload[8..10], &7_u16.to_le_bytes());
        assert_eq!(&payload[10..14], &8_u32.to_le_bytes());
        assert_eq!(&payload[14..18], &2_u32.to_le_bytes());
        assert_eq!(&payload[18..20], &9_u16.to_le_bytes());
        assert_eq!(&payload[20..29], b"capture-7");
        assert_eq!(&payload[29..], &[1, 2, 3, 4]);

        let mut frame = Vec::new();
        write_framed(&mut frame, 1, &payload).unwrap();
        assert_eq!(frame[0], 1);
        assert_eq!(&frame[1..5], &(payload.len() as u32).to_le_bytes());
        assert_eq!(&frame[5..], payload);
    }

    #[test]
    fn encode_user_audio_payload_rejects_non_numeric_user_ids() {
        assert!(encode_user_audio_payload("not-a-user", "capture", &[], 0, 0, 0).is_none());
    }

    #[test]
    fn control_frame_has_exact_header_and_json() {
        let mut frame = Vec::new();
        write_framed(
            &mut frame,
            0,
            serde_json::to_string(&OutMsg::DaveState {
                role: crate::voice_conn::TransportRole::Voice,
                connection_id: Some("connection-1".into()),
                status: DaveStateStatus::Ready,
                protocol_version: Some(1),
            })
            .unwrap()
            .as_bytes(),
        )
        .unwrap();

        let json = br#"{"type":"dave_state","role":"voice","connectionId":"connection-1","status":"ready","protocolVersion":1}"#;
        assert_eq!(frame[0], 0);
        assert_eq!(&frame[1..5], &(json.len() as u32).to_le_bytes());
        assert_eq!(&frame[5..], json);
    }

    #[test]
    fn process_ready_carries_the_mandatory_protocol_version() {
        assert_eq!(
            serde_json::to_value(OutMsg::ProcessReady {
                protocol_version: IPC_PROTOCOL_VERSION,
            })
            .unwrap(),
            serde_json::json!({
                "type": "process_ready",
                "protocolVersion": IPC_PROTOCOL_VERSION
            })
        );
    }

    #[test]
    fn capture_end_stays_behind_pcm_when_the_ordered_lane_is_backpressured() {
        let (audio_tx, audio_rx) = crossbeam_channel::bounded(1);
        let pcm = OutMsg::UserAudio {
            user_id: "42".into(),
            capture_id: "capture-1".into(),
            pcm: vec![1, 0],
            signal_peak_abs: 1,
            signal_active_sample_count: 1,
            signal_sample_count: 1,
        };
        let end = OutMsg::UserAudioEnd {
            user_id: "42".into(),
            capture_id: "capture-1".into(),
        };
        assert!(is_ordered_audio_message(&pcm));
        assert!(is_ordered_audio_message(&end));
        audio_tx.send(pcm).unwrap();

        let producer = std::thread::spawn(move || audio_tx.send(end).unwrap());
        assert!(matches!(audio_rx.recv().unwrap(), OutMsg::UserAudio { .. }));
        assert!(matches!(
            audio_rx.recv().unwrap(),
            OutMsg::UserAudioEnd { .. }
        ));
        producer.join().unwrap();
    }

    #[test]
    fn dropped_native_audio_messages_are_wiped_before_release() {
        let mut msg = OutMsg::UserAudio {
            user_id: "42".into(),
            capture_id: "capture-1".into(),
            pcm: vec![1, 2, 3, 4],
            signal_peak_abs: 1,
            signal_active_sample_count: 2,
            signal_sample_count: 2,
        };

        wipe_user_audio_message(&mut msg);

        let OutMsg::UserAudio { pcm, .. } = msg else {
            panic!("expected user audio");
        };
        assert!(pcm.iter().all(|byte| *byte == 0));

        let (tx, rx) = crossbeam_channel::bounded(1);
        drop(rx);
        let dropped = send_ordered_audio_message(
            &tx,
            OutMsg::UserAudio {
                user_id: "42".into(),
                capture_id: "capture-2".into(),
                pcm: vec![5, 6, 7, 8],
                signal_peak_abs: 1,
                signal_active_sample_count: 2,
                signal_sample_count: 2,
            },
        )
        .expect("disconnected audio lane must return the dropped message");
        let OutMsg::UserAudio { pcm, .. } = *dropped else {
            panic!("expected user audio");
        };
        assert!(pcm.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn correlated_playback_events_serialize_exact_ids() {
        assert_eq!(
            serde_json::to_value(OutMsg::TtsPlaybackState {
                playback_id: "playback-1".into(),
                status: TtsPlaybackStatus::Started,
                reason: None,
            })
            .unwrap(),
            serde_json::json!({
                "type": "tts_playback_state",
                "playbackId": "playback-1",
                "status": "started"
            })
        );
        assert_eq!(
            serde_json::to_value(OutMsg::MusicGainReached {
                music_id: "music-1".into(),
                gain: 0.25,
            })
            .unwrap(),
            serde_json::json!({
                "type": "music_gain_reached",
                "musicId": "music-1",
                "gain": 0.25
            })
        );
    }

    #[test]
    fn transport_errors_and_publish_media_start_serialize_correlation() {
        assert_eq!(
            serde_json::to_value(OutMsg::Error {
                code: super::ErrorCode::VoiceConnectFailed,
                message: "failed".into(),
                role: Some(crate::voice_conn::TransportRole::Voice),
                connection_id: Some("connection-1".into()),
            })
            .unwrap(),
            serde_json::json!({
                "type": "error",
                "code": "voice_connect_failed",
                "message": "failed",
                "role": "voice",
                "connectionId": "connection-1"
            })
        );
        assert_eq!(
            serde_json::to_value(OutMsg::StreamPublishMediaStarted {
                role: crate::voice_conn::TransportRole::StreamPublish,
                connection_generation: 4,
                source_generation: 7,
            })
            .unwrap(),
            serde_json::json!({
                "type": "stream_publish_media_started",
                "role": "stream_publish",
                "connectionGeneration": 4,
                "sourceGeneration": 7
            })
        );
    }

    #[test]
    fn explicit_leave_gateway_payload_is_op4_with_null_channel() {
        assert_eq!(
            gateway_voice_state_payload(42, None, true),
            serde_json::json!({
                "op": 4,
                "d": {
                    "guild_id": "42",
                    "channel_id": null,
                    "self_mute": true,
                    "self_deaf": false
                }
            })
        );
    }

    #[test]
    fn transport_stats_serializes_contract_shape() {
        let msg = OutMsg::TransportStats(TransportStatsSnapshot {
            uptime_ms: 123_456,
            tick: TickStats {
                total: 10,
                skipped: 2,
                slip_events: 1,
                max_gap_ms: 61.5,
            },
            ipc_lanes: IpcLaneStats {
                control_dropped: 3,
                audio_dropped: 4,
                video_dropped: 5,
            },
            inbound_audio: Some(InboundAudioStats {
                packets: 7,
                transport_decrypt_fail: 8,
                dave_decrypt_fail: 9,
                forward_loss_gaps: 10,
                concealed_frames: 11,
            }),
            inbound_video: InboundVideoStats {
                frames_emitted: 12,
                decode_dropped: 13,
                dave_decrypt_ok: 14,
                dave_decrypt_fail: 15,
                dave_passthrough: 16,
            },
            outbound: OutboundStats {
                rtp_audio_sent: 17,
                dave_encrypt_fail: 18,
            },
        });

        let json = serde_json::to_value(&msg).expect("serialize transport stats");
        assert_eq!(
            json,
            serde_json::json!({
                "type": "transport_stats",
                "uptimeMs": 123456,
                "tick": { "total": 10, "skipped": 2, "slipEvents": 1, "maxGapMs": 61.5 },
                "ipcLanes": {
                    "controlDropped": 3,
                    "audioDropped": 4,
                    "videoDropped": 5
                },
                "inboundAudio": {
                    "packets": 7,
                    "transportDecryptFail": 8,
                    "daveDecryptFail": 9,
                    "forwardLossGaps": 10,
                    "concealedFrames": 11
                },
                "inboundVideo": {
                    "framesEmitted": 12,
                    "decodeDropped": 13,
                    "daveDecryptOk": 14,
                    "daveDecryptFail": 15,
                    "davePassthrough": 16
                },
                "outbound": { "rtpAudioSent": 17, "daveEncryptFail": 18 }
            })
        );
    }

    #[test]
    fn inbound_command_deserializes_camel_case_contract_fields() {
        let msg: InMsg = serde_json::from_value(serde_json::json!({
            "type": "subscribe_user_video",
            "userId": "42",
            "maxFramesPerSecond": 3,
            "preferredQuality": 80,
            "preferredPixelCount": 921600,
            "preferredStreamType": "screen",
            "jpegQuality": 70
        }))
        .expect("subscribe_user_video command");

        match msg {
            InMsg::SubscribeUserVideo {
                user_id,
                max_frames_per_second,
                preferred_quality,
                preferred_pixel_count,
                preferred_stream_type,
                jpeg_quality,
            } => {
                assert_eq!(user_id, "42");
                assert_eq!(max_frames_per_second, 3);
                assert_eq!(preferred_quality, 80);
                assert_eq!(preferred_pixel_count, Some(921_600));
                assert_eq!(preferred_stream_type.as_deref(), Some("screen"));
                assert_eq!(jpeg_quality, Some(70));
            }
            _ => panic!("unexpected command"),
        }
    }

    #[test]
    fn voice_state_distinguishes_null_from_omitted_fields() {
        let InMsg::VoiceState { data } = serde_json::from_value(serde_json::json!({
            "type": "voice_state",
            "data": { "channel_id": null }
        }))
        .expect("voice_state command") else {
            panic!("unexpected command");
        };

        assert_eq!(data.channel_id, Some(None));
        assert_eq!(data.session_id, None);
        assert_eq!(data.user_id, None);
    }

    #[test]
    fn read_line_capped_reads_normal_lines_and_eof() {
        let mut reader = std::io::Cursor::new(b"{\"type\":\"destroy\"}\nsecond\n".to_vec());
        let mut buf = Vec::new();

        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 64).unwrap(),
            CappedLine::Line
        );
        assert_eq!(buf, b"{\"type\":\"destroy\"}");
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 64).unwrap(),
            CappedLine::Line
        );
        assert_eq!(buf, b"second");
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 64).unwrap(),
            CappedLine::Eof
        );
    }

    #[test]
    fn read_line_capped_discards_oversized_line_and_recovers_on_next_line() {
        let mut input = vec![b'x'; 1024];
        input.push(b'\n');
        input.extend_from_slice(b"{\"type\":\"destroy\"}\n");
        let mut reader = std::io::Cursor::new(input);
        let mut buf = Vec::new();

        // The oversized line is rejected without buffering it whole…
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 64).unwrap(),
            CappedLine::TooLong
        );
        assert!(buf.len() <= 64, "oversized bytes must not accumulate");

        // …and normal traffic resumes on the very next line.
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 64).unwrap(),
            CappedLine::Line
        );
        assert!(matches!(parse_stdin_line(&buf), Some(InMsg::Destroy)));
    }

    #[test]
    fn read_line_capped_treats_unterminated_tail_as_line() {
        let mut reader = std::io::Cursor::new(b"no-newline".to_vec());
        let mut buf = Vec::new();

        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 64).unwrap(),
            CappedLine::Line
        );
        assert_eq!(buf, b"no-newline");
        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 64).unwrap(),
            CappedLine::Eof
        );
    }

    #[test]
    fn invalid_utf8_line_is_skipped_without_killing_the_reader() {
        // 0xFF is never valid UTF-8; read_line would have returned Err and
        // shut the whole reader (and therefore the process) down.
        let mut input = vec![0xFF, 0xFE, 0xFD, b'\n'];
        input.extend_from_slice(b"{\"type\":\"destroy\"}\n");
        let mut reader = std::io::Cursor::new(input);
        let mut buf = Vec::new();

        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 64).unwrap(),
            CappedLine::Line
        );
        assert!(
            parse_stdin_line(&buf).is_none(),
            "invalid UTF-8 must be skippable"
        );

        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 64).unwrap(),
            CappedLine::Line
        );
        assert!(matches!(parse_stdin_line(&buf), Some(InMsg::Destroy)));
    }
}
