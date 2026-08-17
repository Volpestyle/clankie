use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use crossbeam_channel as crossbeam;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::app_state::transport_stats;
use crate::video::VideoStreamDescriptor;
use crate::voice_conn::TransportRole;

#[derive(Clone, Debug)]
struct IpcSenders {
    control_tx: crossbeam::Sender<OutMsg>,
    audio_tx: crossbeam::Sender<OutMsg>,
    video_tx: crossbeam::Sender<OutMsg>,
    log_tx: crossbeam::Sender<OutMsg>,
    /// Receiver clone used only to pop the oldest queued log message when the
    /// log lane is full — the writer thread holds its own receiver.
    log_rx: crossbeam::Receiver<OutMsg>,
}

static IPC_TX: std::sync::OnceLock<IpcSenders> = std::sync::OnceLock::new();
static DROPPED_OUTBOUND_VIDEO_FRAMES: AtomicU64 = AtomicU64::new(0);
static DROPPED_OUTBOUND_LOG_MESSAGES: AtomicU64 = AtomicU64::new(0);
static DROPPED_OUTBOUND_CONTROL_MESSAGES: AtomicU64 = AtomicU64::new(0);
const MAX_STDIN_LINE_BYTES: usize = 8 * 1_024 * 1_024;
/// Control messages are must-deliver but a stalled parent must not grow the
/// process unbounded — with 4096 undelivered control messages the parent is
/// effectively dead and newer ones are dropped (counted).
const CONTROL_LANE_CAPACITY: usize = 4096;
/// Log messages are best-effort: the lane drops its oldest entry on overflow
/// so a stalled parent caps memory at the lane depth.
const LOG_LANE_CAPACITY: usize = 4096;

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
pub enum InMsg {
    Join {
        #[serde(rename = "guildId")]
        guild_id: String,
        #[serde(rename = "channelId")]
        channel_id: String,
        #[serde(rename = "selfMute", default)]
        self_mute: bool,
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
        #[serde(rename = "serverId")]
        server_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(rename = "daveChannelId")]
        dave_channel_id: String,
    },
    StreamWatchDisconnect {
        #[serde(default)]
        reason: Option<String>,
    },
    StreamPublishConnect {
        endpoint: String,
        token: String,
        #[serde(rename = "serverId")]
        server_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(rename = "daveChannelId")]
        dave_channel_id: String,
    },
    StreamPublishDisconnect {
        #[serde(default)]
        reason: Option<String>,
    },
    Audio {
        #[serde(rename = "pcmBase64")]
        pcm_base64: String,
        #[serde(rename = "sampleRate", default = "default_sample_rate")]
        sample_rate: u32,
    },
    StopPlayback,
    StopTtsPlayback,
    SubscribeUser {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(rename = "silenceDurationMs", default = "default_silence_duration")]
        silence_duration_ms: u32,
        #[serde(rename = "sampleRate", default = "default_sample_rate")]
        sample_rate: u32,
    },
    UnsubscribeUser {
        #[serde(rename = "userId")]
        user_id: String,
    },
    SubscribeUserVideo {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(
            rename = "maxFramesPerSecond",
            default = "default_video_max_frames_per_second"
        )]
        max_frames_per_second: u32,
        #[serde(rename = "preferredQuality", default = "default_video_quality")]
        preferred_quality: u32,
        #[serde(rename = "preferredPixelCount")]
        preferred_pixel_count: Option<u32>,
        #[serde(rename = "preferredStreamType")]
        preferred_stream_type: Option<String>,
        #[serde(rename = "jpegQuality")]
        jpeg_quality: Option<u32>,
    },
    UnsubscribeUserVideo {
        #[serde(rename = "userId")]
        user_id: String,
    },
    MusicPlay {
        url: String,
        #[serde(rename = "resolvedDirectUrl", default)]
        resolved_direct_url: bool,
    },
    MusicStop,
    MusicPause,
    MusicResume,
    MusicSetGain {
        target: f32,
        #[serde(rename = "fadeMs", default)]
        fade_ms: u32,
    },
    StreamPublishPlay {
        url: String,
        #[serde(rename = "resolvedDirectUrl", default)]
        resolved_direct_url: bool,
    },
    StreamPublishPlayVisualizer {
        url: String,
        #[serde(rename = "resolvedDirectUrl", default)]
        resolved_direct_url: bool,
        #[serde(rename = "visualizerMode", default = "default_visualizer_mode")]
        visualizer_mode: String,
    },
    StreamPublishBrowserStart {
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    StreamPublishBrowserFrame {
        #[serde(rename = "mimeType")]
        mime_type: String,
        #[serde(rename = "frameBase64")]
        frame_base64: String,
        #[serde(rename = "capturedAtMs", default)]
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

pub fn default_visualizer_mode() -> String {
    "cqt".to_string()
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

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct TransportStatsSnapshot {
    #[serde(rename = "uptimeMs")]
    pub uptime_ms: u64,
    pub tick: TickStats,
    #[serde(rename = "ipcLanes")]
    pub ipc_lanes: IpcLaneStats,
    #[serde(rename = "inboundAudio", skip_serializing_if = "Option::is_none")]
    pub inbound_audio: Option<InboundAudioStats>,
    #[serde(rename = "inboundVideo")]
    pub inbound_video: InboundVideoStats,
    pub outbound: OutboundStats,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct TickStats {
    pub total: u64,
    pub skipped: u64,
    #[serde(rename = "slipEvents")]
    pub slip_events: u64,
    #[serde(rename = "maxGapMs")]
    pub max_gap_ms: f64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct IpcLaneStats {
    #[serde(rename = "controlDropped")]
    pub control_dropped: u64,
    #[serde(rename = "audioDropped")]
    pub audio_dropped: u64,
    #[serde(rename = "videoDropped")]
    pub video_dropped: u64,
    #[serde(rename = "logDropped")]
    pub log_dropped: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct InboundAudioStats {
    pub packets: u64,
    #[serde(rename = "transportDecryptFail")]
    pub transport_decrypt_fail: u64,
    #[serde(rename = "daveDecryptFail")]
    pub dave_decrypt_fail: u64,
    #[serde(rename = "forwardLossGaps")]
    pub forward_loss_gaps: u64,
    #[serde(rename = "concealedFrames")]
    pub concealed_frames: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct InboundVideoStats {
    #[serde(rename = "framesEmitted")]
    pub frames_emitted: u64,
    #[serde(rename = "decodeDropped")]
    pub decode_dropped: u64,
    #[serde(rename = "daveDecryptOk")]
    pub dave_decrypt_ok: u64,
    #[serde(rename = "daveDecryptFail")]
    pub dave_decrypt_fail: u64,
    #[serde(rename = "davePassthrough")]
    pub dave_passthrough: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct OutboundStats {
    #[serde(rename = "rtpAudioSent")]
    pub rtp_audio_sent: u64,
    #[serde(rename = "daveEncryptFail")]
    pub dave_encrypt_fail: u64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
pub enum OutMsg {
    ProcessReady,
    Ready,
    AdapterSend {
        payload: Value,
    },
    ConnectionState {
        status: String,
    },
    TransportState {
        role: TransportRole,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    PlayerState {
        status: String,
    },
    PlaybackArmed {
        reason: String,
    },
    TtsPlaybackState {
        status: String,
    },
    SpeakingStart {
        #[serde(rename = "userId")]
        user_id: String,
    },
    SpeakingEnd {
        #[serde(rename = "userId")]
        user_id: String,
    },
    UserAudio {
        #[serde(rename = "userId")]
        user_id: String,
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
        #[serde(rename = "userId")]
        user_id: String,
    },
    UserVideoState {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(rename = "audioSsrc", skip_serializing_if = "Option::is_none")]
        audio_ssrc: Option<u32>,
        #[serde(rename = "videoSsrc", skip_serializing_if = "Option::is_none")]
        video_ssrc: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        codec: Option<String>,
        streams: Vec<VideoStreamDescriptor>,
    },
    UserVideoFrame {
        #[serde(rename = "userId")]
        user_id: String,
        ssrc: u32,
        codec: String,
        keyframe: bool,
        #[serde(rename = "frameBase64")]
        frame_base64: String,
        #[serde(rename = "rtpTimestamp")]
        rtp_timestamp: u32,
        #[serde(rename = "streamType", skip_serializing_if = "Option::is_none")]
        stream_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rid: Option<String>,
        #[serde(rename = "daveDecrypted")]
        dave_decrypted: bool,
    },
    /// Pre-decoded video frame (JPEG) from the persistent H264 decoder.
    /// The TS side can ingest this directly without spawning ffmpeg.
    DecodedVideoFrame {
        #[serde(rename = "userId")]
        user_id: String,
        ssrc: u32,
        width: u32,
        height: u32,
        #[serde(rename = "jpegBase64")]
        jpeg_base64: String,
        #[serde(rename = "rtpTimestamp")]
        rtp_timestamp: u32,
        #[serde(rename = "streamType", skip_serializing_if = "Option::is_none")]
        stream_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rid: Option<String>,
        /// Instantaneous coarse-luma diff score (0.0–1.0).
        #[serde(rename = "changeScore")]
        change_score: f32,
        /// EMA-smoothed change score for filtering single-frame noise.
        #[serde(rename = "emaChangeScore")]
        ema_change_score: f32,
        /// True when instantaneous diff indicates a hard scene cut.
        #[serde(rename = "isSceneCut")]
        is_scene_cut: bool,
    },
    UserVideoEnd {
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ssrc: Option<u32>,
    },
    ClientDisconnect {
        #[serde(rename = "userId")]
        user_id: String,
    },
    MusicIdle,
    MusicError {
        message: String,
    },
    MusicGainReached {
        gain: f32,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
    BufferDepth {
        #[serde(rename = "ttsSamples")]
        tts_samples: usize,
        #[serde(rename = "musicSamples")]
        music_samples: usize,
    },
    TransportStats {
        #[serde(rename = "uptimeMs")]
        uptime_ms: u64,
        tick: TickStats,
        #[serde(rename = "ipcLanes")]
        ipc_lanes: IpcLaneStats,
        #[serde(rename = "inboundAudio", skip_serializing_if = "Option::is_none")]
        inbound_audio: Option<InboundAudioStats>,
        #[serde(rename = "inboundVideo")]
        inbound_video: InboundVideoStats,
        outbound: OutboundStats,
    },
    TtsBufferOverflow {
        #[serde(rename = "droppedSamples")]
        dropped_samples: usize,
        #[serde(rename = "droppedMs")]
        dropped_ms: f64,
        #[serde(rename = "bufferSamples")]
        buffer_samples: usize,
        #[serde(rename = "bufferMs")]
        buffer_ms: f64,
    },
    Log {
        level: String,
        target: String,
        message: String,
        fields: Value,
    },
}

#[derive(Deserialize, Debug, Clone)]
pub struct VoiceServerData {
    pub endpoint: Option<String>,
    pub token: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(clippy::struct_field_names)] // These mirror Discord gateway field names verbatim.
pub struct VoiceStateData {
    pub session_id: Option<String>,
    pub user_id: Option<String>,
    pub channel_id: Option<String>,
}

fn is_lossy_inbound_msg(msg: &InMsg) -> bool {
    matches!(msg, InMsg::Audio { .. })
}

fn encode_user_audio_payload(
    user_id: &str,
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

    let mut payload = Vec::with_capacity(8 + 2 + 4 + 4 + pcm.len());
    payload.extend_from_slice(&uid.to_le_bytes());
    payload.extend_from_slice(&signal_peak_abs.to_le_bytes());
    payload.extend_from_slice(&active_sample_count.to_le_bytes());
    payload.extend_from_slice(&sample_count.to_le_bytes());
    payload.extend_from_slice(pcm);
    Some(payload)
}

pub fn send_msg(msg: OutMsg) {
    let Some(tx) = IPC_TX.get() else {
        return;
    };
    match msg {
        OutMsg::UserAudio { .. } => {
            // Audio frames are lossy — drop on backpressure rather than blocking.
            if let Err(err) = tx.audio_tx.try_send(msg) {
                match err {
                    crossbeam::TrySendError::Full(_) => {
                        transport_stats()
                            .ipc_audio_dropped
                            .fetch_add(1, Ordering::Relaxed);
                    }
                    err => {
                        error!("failed to send lossy audio IPC message: {}", err);
                    }
                }
            }
        }
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
                        let (user_id, ssrc) = match &returned {
                            OutMsg::UserVideoFrame { user_id, ssrc, .. }
                            | OutMsg::DecodedVideoFrame { user_id, ssrc, .. } => {
                                (user_id.as_str(), *ssrc)
                            }
                            _ => ("", 0),
                        };
                        warn!(
                            user_id,
                            ssrc,
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
        OutMsg::Log { .. } => {
            // Log traffic is high-volume and best-effort: drop the oldest
            // queued log message on overflow.  No tracing calls in this
            // arm — logging here would recurse through the IPC log layer.
            let mut pending = msg;
            // Delivered — or the writer is gone and the message is moot.
            while let Err(crossbeam::TrySendError::Full(returned)) = tx.log_tx.try_send(pending) {
                if tx.log_rx.try_recv().is_ok() {
                    DROPPED_OUTBOUND_LOG_MESSAGES.fetch_add(1, Ordering::Relaxed);
                    transport_stats()
                        .ipc_log_dropped
                        .fetch_add(1, Ordering::Relaxed);
                }
                pending = returned;
            }
        }
        _ => {
            // Control messages must not block real-time async tasks. Route
            // them through a bounded control lane handled by the writer
            // thread; the lane is deep enough that dropping only happens
            // once the parent has stalled past any hope of recovery.
            match tx.control_tx.try_send(msg) {
                Ok(()) => {}
                Err(crossbeam::TrySendError::Full(_)) => {
                    transport_stats()
                        .ipc_control_dropped
                        .fetch_add(1, Ordering::Relaxed);
                    let dropped =
                        DROPPED_OUTBOUND_CONTROL_MESSAGES.fetch_add(1, Ordering::Relaxed) + 1;
                    if dropped == 1 || dropped.is_multiple_of(1000) {
                        error!(
                            dropped_control_messages = dropped,
                            "control IPC lane full; parent appears stalled — dropping control message"
                        );
                    }
                }
                Err(err @ crossbeam::TrySendError::Disconnected(_)) => {
                    error!("failed to send control IPC message: {}", err);
                }
            }
        }
    }
}

pub fn send_error(code: ErrorCode, message: impl Into<String>) {
    send_msg(OutMsg::Error {
        code,
        message: message.into(),
    });
}

pub fn try_send_error(code: ErrorCode, message: impl Into<String>) {
    if let Some(tx) = IPC_TX.get() {
        let msg = OutMsg::Error {
            code,
            message: message.into(),
        };
        if let Err(err) = tx.control_tx.try_send(msg) {
            error!("failed to enqueue non-blocking IPC error: {}", err);
        }
    }
}

pub fn send_tts_playback_state(status: &str, reason: &str) {
    info!(
        status = status,
        reason = reason,
        "clankvox_tts_playback_state"
    );
    send_msg(OutMsg::TtsPlaybackState {
        status: status.to_string(),
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
    send_msg(OutMsg::TransportStats {
        uptime_ms: snapshot.uptime_ms,
        tick: snapshot.tick,
        ipc_lanes: snapshot.ipc_lanes,
        inbound_audio: snapshot.inbound_audio,
        inbound_video: snapshot.inbound_video,
        outbound: snapshot.outbound,
    });
}

pub fn send_gateway_voice_state_update(guild_id: u64, channel_id: u64, self_mute: bool) {
    send_msg(OutMsg::AdapterSend {
        payload: serde_json::json!({
            "op": 4,
            "d": {
                "guild_id": guild_id.to_string(),
                "channel_id": channel_id.to_string(),
                "self_mute": self_mute,
                "self_deaf": false,
            }
        }),
    });
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
fn parse_stdin_line(line: &[u8], audio_debug: bool) -> Option<InMsg> {
    let Ok(text) = std::str::from_utf8(line) else {
        if audio_debug {
            eprintln!(
                "[rust-subprocess] Dropping stdin line with invalid UTF-8 ({} bytes)",
                line.len()
            );
        }
        try_send_error(
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
            if audio_debug {
                eprintln!(
                    "[rust-subprocess] JSON parse error: {} ({} bytes)",
                    err,
                    line.len()
                );
            }
            try_send_error(
                ErrorCode::InvalidJson,
                format!("Invalid stdin JSON message: {err}"),
            );
            None
        }
    }
}

pub struct InboundIpc {
    control_rx: mpsc::UnboundedReceiver<InMsg>,
    audio_rx: mpsc::Receiver<InMsg>,
}

impl InboundIpc {
    pub async fn recv(&mut self) -> Option<InMsg> {
        tokio::select! {
            biased;
            Some(msg) = self.control_rx.recv() => Some(msg),
            Some(msg) = self.audio_rx.recv() => Some(msg),
            else => None,
        }
    }
}

pub fn spawn_ipc_reader(audio_debug: bool) -> InboundIpc {
    let (control_tx, control_rx) = mpsc::unbounded_channel::<InMsg>();
    let (audio_tx, audio_rx) = mpsc::channel::<InMsg>(256);

    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut handle = stdin.lock();
        let mut line_buf: Vec<u8> = Vec::new();
        let mut dropped_audio_messages: u64 = 0;

        loop {
            match read_line_capped(&mut handle, &mut line_buf, MAX_STDIN_LINE_BYTES) {
                Ok(CappedLine::Eof) => break,
                Ok(CappedLine::TooLong) => {
                    if audio_debug {
                        eprintln!(
                            "[rust-subprocess] Dropping oversized stdin line (> {MAX_STDIN_LINE_BYTES} bytes)"
                        );
                    }
                    try_send_error(
                        ErrorCode::InputTooLarge,
                        format!("Dropped oversized stdin line (> {MAX_STDIN_LINE_BYTES} bytes)"),
                    );
                }
                Ok(CappedLine::Line) => {
                    let Some(msg) = parse_stdin_line(&line_buf, audio_debug) else {
                        continue;
                    };

                    if is_lossy_inbound_msg(&msg) {
                        match audio_tx.try_send(msg) {
                            Ok(()) => {
                                if dropped_audio_messages > 0 {
                                    info!(
                                        dropped_audio_messages = dropped_audio_messages,
                                        "clankvox_inbound_audio_backpressure_recovered"
                                    );
                                    dropped_audio_messages = 0;
                                }
                            }
                            Err(mpsc::error::TrySendError::Full(_)) => {
                                dropped_audio_messages = dropped_audio_messages.saturating_add(1);
                                if dropped_audio_messages == 1
                                    || dropped_audio_messages.is_multiple_of(100)
                                {
                                    warn!(
                                        dropped_audio_messages = dropped_audio_messages,
                                        "dropping inbound clankvox audio IPC due to backpressure"
                                    );
                                }
                            }
                            Err(mpsc::error::TrySendError::Closed(_)) => break,
                        }
                    } else if control_tx.send(msg).is_err() {
                        break;
                    }
                }
                Err(err) => {
                    warn!(error = %err, "stdin reader exiting after read error");
                    break;
                }
            }
        }

        let _ = control_tx.send(InMsg::Destroy);
    });

    InboundIpc {
        control_rx,
        audio_rx,
    }
}

pub fn spawn_ipc_writer() {
    if IPC_TX.get().is_some() {
        return;
    }

    let (control_tx, control_rx) = crossbeam::bounded::<OutMsg>(CONTROL_LANE_CAPACITY);
    let (audio_tx, audio_rx) = crossbeam::bounded::<OutMsg>(512);
    let (video_tx, video_rx) = crossbeam::bounded::<OutMsg>(64);
    let (log_tx, log_rx) = crossbeam::bounded::<OutMsg>(LOG_LANE_CAPACITY);
    let writer_log_rx = log_rx.clone();
    std::thread::spawn(move || {
        let mut out = io::stdout().lock();
        loop {
            // Writer priority: control > audio > video > log.  Log messages
            // are drained only when every media lane is idle so log bursts
            // can never preempt realtime audio/video delivery.
            let msg = if let Ok(msg) = control_rx.try_recv() {
                msg
            } else if let Ok(msg) = audio_rx.try_recv() {
                msg
            } else if let Ok(msg) = video_rx.try_recv() {
                msg
            } else if let Ok(msg) = writer_log_rx.try_recv() {
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
                    recv(writer_log_rx) -> msg => match msg {
                        Ok(msg) => msg,
                        Err(_) => break,
                    },
                }
            };

            match msg {
                OutMsg::UserAudio {
                    user_id,
                    pcm,
                    signal_peak_abs,
                    signal_active_sample_count,
                    signal_sample_count,
                } => {
                    let Some(payload) = encode_user_audio_payload(
                        &user_id,
                        &pcm,
                        signal_peak_abs,
                        signal_active_sample_count,
                        signal_sample_count,
                    ) else {
                        continue;
                    };

                    let len = payload.len() as u32;
                    if let Err(e) = out
                        .write_all(&[1])
                        .and_then(|()| out.write_all(&len.to_le_bytes()))
                        .and_then(|()| out.write_all(&payload))
                        .and_then(|()| out.flush())
                    {
                        // Stdout broken — parent process likely exited. Audio frames
                        // are lossy so we just log once and let the reader thread
                        // detect stdin EOF to trigger a clean shutdown.
                        error!("IPC stdout write failed (audio): {e}");
                        break;
                    }
                }
                other => {
                    if let Ok(json) = serde_json::to_string(&other) {
                        let payload = json.as_bytes();
                        let len = payload.len() as u32;
                        if let Err(e) = out
                            .write_all(&[0])
                            .and_then(|()| out.write_all(&len.to_le_bytes()))
                            .and_then(|()| out.write_all(payload))
                            .and_then(|()| out.flush())
                        {
                            error!("IPC stdout write failed (control): {e}");
                            break;
                        }
                    }
                }
            }
        }
    });

    let senders = IpcSenders {
        control_tx,
        audio_tx,
        video_tx,
        log_tx,
        log_rx,
    };
    IPC_TX
        .set(senders.clone())
        .expect("IPC_TX already initialized");
}

#[cfg(test)]
mod tests {
    use super::{
        CappedLine, InMsg, InboundAudioStats, InboundVideoStats, IpcLaneStats, OutMsg,
        OutboundStats, TickStats, encode_user_audio_payload, parse_stdin_line, read_line_capped,
    };

    #[test]
    fn encode_user_audio_payload_serializes_header_fields() {
        let payload = encode_user_audio_payload("42", &[1, 2, 3, 4], 7, 8, 9).expect("payload");

        assert_eq!(&payload[0..8], &42_u64.to_le_bytes());
        assert_eq!(&payload[8..10], &7_u16.to_le_bytes());
        assert_eq!(&payload[10..14], &8_u32.to_le_bytes());
        assert_eq!(&payload[14..18], &9_u32.to_le_bytes());
        assert_eq!(&payload[18..], &[1, 2, 3, 4]);
    }

    #[test]
    fn encode_user_audio_payload_rejects_non_numeric_user_ids() {
        assert!(encode_user_audio_payload("not-a-user", &[], 0, 0, 0).is_none());
    }

    #[test]
    fn transport_stats_serializes_contract_shape() {
        let msg = OutMsg::TransportStats {
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
                log_dropped: 6,
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
        };

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
                    "videoDropped": 5,
                    "logDropped": 6
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
    fn transport_stats_serialized_example_includes_inbound_audio() {
        let msg = OutMsg::TransportStats {
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
                log_dropped: 6,
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
        };

        let serialized = serde_json::to_string(&msg).expect("serialize transport stats");
        assert_eq!(
            serialized,
            "{\"type\":\"transport_stats\",\"uptimeMs\":123456,\"tick\":{\"total\":10,\"skipped\":2,\"slipEvents\":1,\"maxGapMs\":61.5},\"ipcLanes\":{\"controlDropped\":3,\"audioDropped\":4,\"videoDropped\":5,\"logDropped\":6},\"inboundAudio\":{\"packets\":7,\"transportDecryptFail\":8,\"daveDecryptFail\":9,\"forwardLossGaps\":10,\"concealedFrames\":11},\"inboundVideo\":{\"framesEmitted\":12,\"decodeDropped\":13,\"daveDecryptOk\":14,\"daveDecryptFail\":15,\"davePassthrough\":16},\"outbound\":{\"rtpAudioSent\":17,\"daveEncryptFail\":18}}"
        );
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
        assert!(matches!(
            parse_stdin_line(&buf, false),
            Some(InMsg::Destroy)
        ));
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
            parse_stdin_line(&buf, false).is_none(),
            "invalid UTF-8 must be skippable"
        );

        assert_eq!(
            read_line_capped(&mut reader, &mut buf, 64).unwrap(),
            CappedLine::Line
        );
        assert!(matches!(
            parse_stdin_line(&buf, false),
            Some(InMsg::Destroy)
        ));
    }
}
