use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use audiopus::coder::Decoder as OpusDecoder;
use crossbeam_channel as crossbeam;
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio::time;

use crate::audio_pipeline::{AudioSendState, clear_audio_send_buffer};
use crate::capture::{SpeakingState, UserCaptureState};
use crate::dave::DaveManager;
use crate::ipc::{
    DaveStateStatus, ErrorCode, InboundAudioStats, InboundVideoStats, IpcLaneStats, OutMsg,
    OutboundStats, TickStats, TransportStatsSnapshot, TtsPlaybackStatus, send_error,
    send_gateway_voice_state_update, send_msg, send_transport_error, send_tts_playback_state,
};
use crate::music::{MusicEvent, MusicPcm, MusicState, drain_music_pcm_queue};
use crate::stream_publish::{StreamPublishEvent, StreamPublishFrame, StreamPublishState};
use crate::video::{RemoteVideoState, UserVideoSubscription};
use crate::video_decode_worker::VideoDecodeWorker;
use crate::voice_conn::{TransportRole, VoiceConnection, VoiceEvent};

#[derive(Default, Clone)]
pub(crate) struct PendingConnection {
    pub(crate) endpoint: Option<String>,
    pub(crate) token: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) user_id: Option<u64>,
}

#[derive(Default, Clone)]
pub(crate) struct PendingStreamConnection {
    pub(crate) endpoint: Option<String>,
    pub(crate) token: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) user_id: Option<u64>,
    pub(crate) server_id: Option<u64>,
    pub(crate) dave_channel_id: Option<u64>,
}

#[derive(Default, Clone, Copy)]
struct TransportLifecycle {
    generation: u64,
    ready: bool,
    pending_dave_ready: Option<u16>,
    dave_ready: Option<u16>,
}

pub(crate) fn parse_user_id_field(user_id: &str, context: &str) -> Option<u64> {
    if let Ok(uid) = user_id.parse::<u64>() {
        Some(uid)
    } else {
        send_error(
            ErrorCode::InvalidRequest,
            format!("{context} requires a numeric user_id, got {user_id:?}"),
        );
        None
    }
}

static TRANSPORT_STATS: OnceLock<TransportStats> = OnceLock::new();

pub(crate) fn transport_stats() -> &'static TransportStats {
    TRANSPORT_STATS.get_or_init(TransportStats::new)
}

pub(crate) struct TransportStats {
    started_at: Instant,
    pub(crate) tick_total: AtomicU64,
    pub(crate) tick_skipped: AtomicU64,
    pub(crate) tick_slip_events: AtomicU64,
    pub(crate) tick_max_gap_micros: AtomicU64,
    pub(crate) ipc_control_dropped: AtomicU64,
    pub(crate) ipc_audio_dropped: AtomicU64,
    pub(crate) ipc_video_dropped: AtomicU64,
    pub(crate) inbound_audio_packets: AtomicU64,
    pub(crate) inbound_audio_transport_decrypt_fail: AtomicU64,
    pub(crate) inbound_audio_dave_decrypt_fail: AtomicU64,
    pub(crate) inbound_audio_forward_loss_gaps: AtomicU64,
    pub(crate) inbound_audio_concealed_frames: AtomicU64,
    pub(crate) inbound_video_frames_emitted: AtomicU64,
    pub(crate) inbound_video_decode_dropped: AtomicU64,
    pub(crate) inbound_video_dave_decrypt_ok: AtomicU64,
    pub(crate) inbound_video_dave_decrypt_fail: AtomicU64,
    pub(crate) inbound_video_dave_passthrough: AtomicU64,
    pub(crate) outbound_rtp_audio_sent: AtomicU64,
    pub(crate) outbound_dave_encrypt_fail: AtomicU64,
}

impl TransportStats {
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
            tick_total: AtomicU64::new(0),
            tick_skipped: AtomicU64::new(0),
            tick_slip_events: AtomicU64::new(0),
            tick_max_gap_micros: AtomicU64::new(0),
            ipc_control_dropped: AtomicU64::new(0),
            ipc_audio_dropped: AtomicU64::new(0),
            ipc_video_dropped: AtomicU64::new(0),
            inbound_audio_packets: AtomicU64::new(0),
            inbound_audio_transport_decrypt_fail: AtomicU64::new(0),
            inbound_audio_dave_decrypt_fail: AtomicU64::new(0),
            inbound_audio_forward_loss_gaps: AtomicU64::new(0),
            inbound_audio_concealed_frames: AtomicU64::new(0),
            inbound_video_frames_emitted: AtomicU64::new(0),
            inbound_video_decode_dropped: AtomicU64::new(0),
            inbound_video_dave_decrypt_ok: AtomicU64::new(0),
            inbound_video_dave_decrypt_fail: AtomicU64::new(0),
            inbound_video_dave_passthrough: AtomicU64::new(0),
            outbound_rtp_audio_sent: AtomicU64::new(0),
            outbound_dave_encrypt_fail: AtomicU64::new(0),
        }
    }

    pub(crate) fn record_tick(&self, skipped: u64, gap: Option<Duration>) {
        self.tick_total.fetch_add(1, Ordering::Relaxed);
        if skipped == 0 {
            return;
        }

        self.tick_skipped.fetch_add(skipped, Ordering::Relaxed);
        self.tick_slip_events.fetch_add(1, Ordering::Relaxed);
        if let Some(gap) = gap {
            let gap_micros = u64::try_from(gap.as_micros()).unwrap_or(u64::MAX);
            update_atomic_max(&self.tick_max_gap_micros, gap_micros);
        }
    }

    pub(crate) fn snapshot(&self) -> TransportStatsSnapshot {
        TransportStatsSnapshot {
            uptime_ms: u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX),
            tick: TickStats {
                total: self.tick_total.load(Ordering::Relaxed),
                skipped: self.tick_skipped.load(Ordering::Relaxed),
                slip_events: self.tick_slip_events.load(Ordering::Relaxed),
                max_gap_ms: self.tick_max_gap_micros.load(Ordering::Relaxed) as f64 / 1_000.0,
            },
            ipc_lanes: IpcLaneStats {
                control_dropped: self.ipc_control_dropped.load(Ordering::Relaxed),
                audio_dropped: self.ipc_audio_dropped.load(Ordering::Relaxed),
                video_dropped: self.ipc_video_dropped.load(Ordering::Relaxed),
            },
            inbound_audio: Some(InboundAudioStats {
                packets: self.inbound_audio_packets.load(Ordering::Relaxed),
                transport_decrypt_fail: self
                    .inbound_audio_transport_decrypt_fail
                    .load(Ordering::Relaxed),
                dave_decrypt_fail: self.inbound_audio_dave_decrypt_fail.load(Ordering::Relaxed),
                forward_loss_gaps: self.inbound_audio_forward_loss_gaps.load(Ordering::Relaxed),
                concealed_frames: self.inbound_audio_concealed_frames.load(Ordering::Relaxed),
            }),
            inbound_video: InboundVideoStats {
                frames_emitted: self.inbound_video_frames_emitted.load(Ordering::Relaxed),
                decode_dropped: self.inbound_video_decode_dropped.load(Ordering::Relaxed),
                dave_decrypt_ok: self.inbound_video_dave_decrypt_ok.load(Ordering::Relaxed),
                dave_decrypt_fail: self.inbound_video_dave_decrypt_fail.load(Ordering::Relaxed),
                dave_passthrough: self.inbound_video_dave_passthrough.load(Ordering::Relaxed),
            },
            outbound: OutboundStats {
                rtp_audio_sent: self.outbound_rtp_audio_sent.load(Ordering::Relaxed),
                dave_encrypt_fail: self.outbound_dave_encrypt_fail.load(Ordering::Relaxed),
            },
        }
    }
}

fn update_atomic_max(target: &AtomicU64, value: u64) {
    let mut current = target.load(Ordering::Relaxed);
    while value > current {
        match target.compare_exchange_weak(current, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(next) => current = next,
        }
    }
}

#[allow(clippy::struct_excessive_bools)] // Serialized event-loop state uses independent lifecycle flags.
pub(crate) struct AppState {
    pub(crate) pending_conn: PendingConnection,
    pub(crate) connection_id: Option<String>,
    pub(crate) guild_id: Option<u64>,
    pub(crate) channel_id: Option<u64>,
    pub(crate) self_mute: bool,
    pub(crate) reconnect_deadline: Option<time::Instant>,
    pub(crate) reconnect_attempt: u32,
    pub(crate) dave: Arc<Mutex<Option<DaveManager>>>,
    pub(crate) voice_conn: Option<VoiceConnection>,
    pub(crate) stream_watch_pending_conn: PendingStreamConnection,
    pub(crate) stream_watch_dave: Arc<Mutex<Option<DaveManager>>>,
    pub(crate) stream_watch_conn: Option<VoiceConnection>,
    pub(crate) stream_publish_pending_conn: PendingStreamConnection,
    pub(crate) stream_publish_dave: Arc<Mutex<Option<DaveManager>>>,
    pub(crate) stream_publish_conn: Option<VoiceConnection>,
    transport_lifecycles: [TransportLifecycle; 3],
    pub(crate) voice_event_tx: mpsc::Sender<VoiceEvent>,
    pub(crate) audio_send_state: Arc<Mutex<Option<AudioSendState>>>,
    pub(crate) music_pcm_tx: crossbeam::Sender<MusicPcm>,
    pub(crate) music_pcm_rx: crossbeam::Receiver<MusicPcm>,
    pub(crate) music_event_tx: mpsc::Sender<MusicEvent>,
    pub(crate) stream_publish_frame_tx: crossbeam::Sender<StreamPublishFrame>,
    pub(crate) stream_publish_frame_rx: crossbeam::Receiver<StreamPublishFrame>,
    pub(crate) stream_publish_event_tx: crossbeam::Sender<StreamPublishEvent>,
    pub(crate) stream_publish_event_rx: crossbeam::Receiver<StreamPublishEvent>,
    pub(crate) music: MusicState,
    pub(crate) stream_publish: StreamPublishState,
    pub(crate) opus_decoders: HashMap<u32, OpusDecoder>,
    /// Last RTP sequence number seen per audio SSRC, for gap detection / FEC / PLC.
    pub(crate) last_rtp_seq: HashMap<u32, u16>,
    pub(crate) ssrc_map: HashMap<u32, u64>,
    pub(crate) user_capture_states: HashMap<u64, UserCaptureState>,
    pub(crate) user_video_subscriptions: HashMap<(TransportRole, u64), UserVideoSubscription>,
    /// Dedicated decode thread for inbound H264 watch frames — keeps
    /// openh264/turbojpeg work off the event loop.
    pub(crate) video_decode_worker: VideoDecodeWorker,
    pub(crate) remote_video_states: HashMap<(TransportRole, u64), RemoteVideoState>,
    pub(crate) speaking_states: HashMap<u64, SpeakingState>,
    pub(crate) buffer_depth_tick_counter: u32,
    pub(crate) transport_stats_tick_counter: u32,
    pub(crate) buffer_depth_was_nonempty: bool,
    pub(crate) tts_playback_id: Option<String>,
    pub(crate) failed_tts_playback_ids: VecDeque<String>,
    pub(crate) tts_finish_pending: bool,
    pub(crate) tts_playback_buffered: bool,
    pub(crate) tts_playback_started: bool,
    pub(crate) stream_publish_frames_sent: u64,
    /// Consecutive DAVE encrypt failures on the outbound voice path.  Frames
    /// are dropped (never sent plaintext) and an IPC error is raised once the
    /// streak crosses [`DAVE_ENCRYPT_FAILURE_ALERT_THRESHOLD`].
    pub(crate) dave_audio_encrypt_failures: u32,
    /// Consecutive DAVE encrypt failures on the outbound stream-publish path.
    pub(crate) stream_publish_encrypt_failures: u32,
    /// Reusable Opus decode output buffer (worst-case 120ms @ 48kHz stereo),
    /// shared by the PLC/FEC/normal decode passes — avoids up to three
    /// allocations per inbound audio packet.
    pub(crate) opus_pcm_scratch: Vec<i16>,
}

/// Consecutive outbound DAVE encrypt failures tolerated before raising a
/// structured IPC error (~0.5s of 20ms audio ticks).
pub(crate) const DAVE_ENCRYPT_FAILURE_ALERT_THRESHOLD: u32 = 25;
pub(crate) const MAX_FAILED_TTS_PLAYBACK_IDS: usize = 64;

impl AppState {
    pub(crate) const BUFFER_DEPTH_REPORT_INTERVAL: u32 = 25;
    pub(crate) const TRANSPORT_STATS_REPORT_INTERVAL: u32 = 250;

    pub(crate) fn new(
        dave: Arc<Mutex<Option<DaveManager>>>,
        voice_event_tx: mpsc::Sender<VoiceEvent>,
        audio_send_state: Arc<Mutex<Option<AudioSendState>>>,
        music_pcm_tx: crossbeam::Sender<MusicPcm>,
        music_pcm_rx: crossbeam::Receiver<MusicPcm>,
        music_event_tx: mpsc::Sender<MusicEvent>,
        stream_publish_frame_tx: crossbeam::Sender<StreamPublishFrame>,
        stream_publish_frame_rx: crossbeam::Receiver<StreamPublishFrame>,
        stream_publish_event_tx: crossbeam::Sender<StreamPublishEvent>,
        stream_publish_event_rx: crossbeam::Receiver<StreamPublishEvent>,
    ) -> Self {
        let _ = transport_stats();
        Self {
            pending_conn: PendingConnection::default(),
            connection_id: None,
            guild_id: None,
            channel_id: None,
            self_mute: false,
            reconnect_deadline: None,
            reconnect_attempt: 0,
            dave,
            voice_conn: None,
            stream_watch_pending_conn: PendingStreamConnection::default(),
            stream_watch_dave: Arc::new(Mutex::new(None)),
            stream_watch_conn: None,
            stream_publish_pending_conn: PendingStreamConnection::default(),
            stream_publish_dave: Arc::new(Mutex::new(None)),
            stream_publish_conn: None,
            transport_lifecycles: [TransportLifecycle::default(); 3],
            voice_event_tx,
            audio_send_state,
            music_pcm_tx,
            music_pcm_rx,
            music_event_tx,
            stream_publish_frame_tx,
            stream_publish_frame_rx,
            stream_publish_event_tx,
            stream_publish_event_rx,
            music: MusicState::default(),
            stream_publish: StreamPublishState::default(),
            opus_decoders: HashMap::new(),
            last_rtp_seq: HashMap::new(),
            ssrc_map: HashMap::new(),
            user_capture_states: HashMap::new(),
            user_video_subscriptions: HashMap::new(),
            video_decode_worker: VideoDecodeWorker::spawn(),
            remote_video_states: HashMap::new(),
            speaking_states: HashMap::new(),
            buffer_depth_tick_counter: 0,
            transport_stats_tick_counter: 0,
            buffer_depth_was_nonempty: false,
            tts_playback_id: None,
            failed_tts_playback_ids: VecDeque::new(),
            tts_finish_pending: false,
            tts_playback_buffered: false,
            tts_playback_started: false,
            stream_publish_frames_sent: 0,
            dave_audio_encrypt_failures: 0,
            stream_publish_encrypt_failures: 0,
            opus_pcm_scratch: vec![0; crate::capture_supervisor::OPUS_DECODE_MAX_SAMPLES],
        }
    }

    pub(crate) fn start_music_pipeline(
        &mut self,
        music_id: &str,
        url: &str,
        resolved_direct_url: bool,
        clear_output_buffers: bool,
    ) {
        crate::music::start_music_pipeline(
            crate::music::MusicPipelineRequest {
                music_id,
                url,
                resolved_direct_url,
                clear_output_buffers,
            },
            crate::music::MusicPipelineContext {
                music_player: &mut self.music.player,
                music_pcm_rx: &self.music_pcm_rx,
                music_pcm_tx: &self.music_pcm_tx,
                music_event_tx: &self.music_event_tx,
                audio_send_state: &self.audio_send_state,
            },
        );
    }

    pub(crate) fn schedule_reconnect(&mut self, reason: &str) {
        let (Some(guild_id), Some(channel_id), Some(connection_id)) =
            (self.guild_id, self.channel_id, self.connection_id.clone())
        else {
            tracing::warn!(reason, "reconnect skipped: missing guild/channel");
            return;
        };
        if self.pending_conn.endpoint.is_none()
            || self.pending_conn.token.is_none()
            || self.pending_conn.session_id.is_none()
            || self.pending_conn.user_id.is_none()
        {
            tracing::warn!(
                reason,
                "reconnect skipped: primary credentials were cleared"
            );
            return;
        }

        self.reconnect_attempt = self.reconnect_attempt.saturating_add(1);
        let backoff_ms = 1_000u64 << self.reconnect_attempt.saturating_sub(1).min(4);
        self.reconnect_deadline =
            Some(time::Instant::now() + std::time::Duration::from_millis(backoff_ms));

        send_msg(OutMsg::ConnectionState {
            status: "reconnecting".into(),
            connection_id,
        });
        self.emit_transport_state(TransportRole::Voice, "reconnecting", Some(reason));
        send_gateway_voice_state_update(guild_id, channel_id, self.self_mute);
        tracing::warn!(
            attempt = self.reconnect_attempt,
            backoff_ms,
            reason,
            "scheduled clankvox voice reconnect"
        );
    }

    pub(crate) fn reset_reconnect(&mut self) {
        self.reconnect_deadline = None;
        self.reconnect_attempt = 0;
    }

    pub(crate) fn clear_voice_connection(&mut self) {
        if let Some(ref conn) = self.voice_conn {
            conn.shutdown();
        }
        self.voice_conn = None;
        self.begin_transport_generation(TransportRole::Voice);
        *self.dave.lock() = None;
        clear_audio_send_buffer(&self.audio_send_state);
        *self.audio_send_state.lock() = None;
        self.emit_dave_state(TransportRole::Voice, DaveStateStatus::Cleared, None);
    }

    pub(crate) fn clear_stream_watch_connection(&mut self) {
        if let Some(ref conn) = self.stream_watch_conn {
            conn.shutdown();
        }
        self.stream_watch_conn = None;
        self.begin_transport_generation(TransportRole::StreamWatch);
        *self.stream_watch_dave.lock() = None;
        self.remote_video_states
            .retain(|(role, _), _| *role != TransportRole::StreamWatch);
        for ((role, _), subscription) in &mut self.user_video_subscriptions {
            if *role == TransportRole::StreamWatch {
                subscription.reset_runtime();
            }
        }
        self.video_decode_worker
            .clear_role(TransportRole::StreamWatch);
        self.emit_dave_state(TransportRole::StreamWatch, DaveStateStatus::Cleared, None);
    }

    pub(crate) fn clear_stream_publish_connection(&mut self) {
        if let Some(ref conn) = self.stream_publish_conn {
            conn.shutdown();
        }
        self.stream_publish_conn = None;
        self.begin_transport_generation(TransportRole::StreamPublish);
        self.stream_publish.reset_media_started();
        *self.stream_publish_dave.lock() = None;
        self.emit_dave_state(TransportRole::StreamPublish, DaveStateStatus::Cleared, None);
    }

    pub(crate) fn connection_for_role(&self, role: TransportRole) -> Option<&VoiceConnection> {
        match role {
            TransportRole::Voice => self.voice_conn.as_ref(),
            TransportRole::StreamWatch => self.stream_watch_conn.as_ref(),
            TransportRole::StreamPublish => self.stream_publish_conn.as_ref(),
        }
    }

    pub(crate) fn is_self_user(&self, role: TransportRole, user_id: u64) -> bool {
        (match role {
            TransportRole::Voice => self.pending_conn.user_id,
            TransportRole::StreamWatch => self.stream_watch_pending_conn.user_id,
            TransportRole::StreamPublish => self.stream_publish_pending_conn.user_id,
        }) == Some(user_id)
    }

    pub(crate) fn emit_transport_state(
        &self,
        role: TransportRole,
        status: &str,
        reason: Option<&str>,
    ) {
        if role == TransportRole::Voice && self.connection_id.is_none() {
            return;
        }
        send_msg(OutMsg::TransportState {
            role,
            connection_id: self.connection_id_for_role(role),
            status: status.to_string(),
            reason: reason.map(ToString::to_string),
        });
    }

    pub(crate) fn emit_dave_state(
        &self,
        role: TransportRole,
        status: DaveStateStatus,
        protocol_version: Option<u16>,
    ) {
        if role == TransportRole::Voice && self.connection_id.is_none() {
            return;
        }
        send_msg(OutMsg::DaveState {
            role,
            connection_id: self.connection_id_for_role(role),
            status,
            protocol_version,
        });
    }

    fn lifecycle_index(role: TransportRole) -> usize {
        match role {
            TransportRole::Voice => 0,
            TransportRole::StreamWatch => 1,
            TransportRole::StreamPublish => 2,
        }
    }

    fn connection_id_for_role(&self, role: TransportRole) -> Option<String> {
        (role == TransportRole::Voice)
            .then(|| self.connection_id.clone())
            .flatten()
    }

    pub(crate) fn current_transport_generation(&self, role: TransportRole) -> u64 {
        self.transport_lifecycles[Self::lifecycle_index(role)].generation
    }

    pub(crate) fn begin_transport_generation(&mut self, role: TransportRole) -> u64 {
        let lifecycle = &mut self.transport_lifecycles[Self::lifecycle_index(role)];
        lifecycle.generation = lifecycle.generation.wrapping_add(1);
        lifecycle.ready = false;
        lifecycle.pending_dave_ready = None;
        lifecycle.dave_ready = None;
        lifecycle.generation
    }

    pub(crate) fn is_current_voice_event(&self, event: &VoiceEvent) -> bool {
        self.current_transport_generation(event.role()) == event.generation()
    }

    pub(crate) fn mark_transport_ready(&mut self, role: TransportRole) -> (bool, Option<u16>) {
        let lifecycle = &mut self.transport_lifecycles[Self::lifecycle_index(role)];
        if lifecycle.ready {
            return (false, None);
        }
        lifecycle.ready = true;
        let ready = lifecycle.pending_dave_ready.take();
        if let Some(protocol_version) = ready {
            lifecycle.dave_ready = Some(protocol_version);
        }
        (true, ready)
    }

    pub(crate) fn mark_dave_ready(&mut self, role: TransportRole, protocol_version: u16) -> bool {
        let lifecycle = &mut self.transport_lifecycles[Self::lifecycle_index(role)];
        if !lifecycle.ready {
            lifecycle.pending_dave_ready = Some(protocol_version);
            return false;
        }
        if lifecycle.dave_ready == Some(protocol_version) {
            return false;
        }
        lifecycle.dave_ready = Some(protocol_version);
        true
    }

    pub(crate) fn dave_ready_protocol_version(&self, role: TransportRole) -> Option<u16> {
        self.transport_lifecycles[Self::lifecycle_index(role)].dave_ready
    }

    pub(crate) fn clear_primary_runtime_state(&mut self, reason: &str) {
        let cleared_audio_ssrcs = self.ssrc_map.len();
        let cleared_decoders = self.opus_decoders.len();
        let cleared_speaking_users = self.speaking_states.len();
        let cleared_capture_users = self.user_capture_states.len();
        let capture_states = std::mem::take(&mut self.user_capture_states);
        for (&user_id, state) in &capture_states {
            if state.stream_active {
                send_msg(OutMsg::UserAudioEnd {
                    user_id: user_id.to_string(),
                    capture_id: state.capture_id.clone(),
                });
            }
        }
        for (&user_id, state) in &self.speaking_states {
            if state.is_speaking {
                send_msg(OutMsg::SpeakingEnd {
                    user_id: user_id.to_string(),
                    capture_id: capture_states
                        .get(&user_id)
                        .map(|capture| capture.capture_id.clone()),
                });
            }
        }
        self.ssrc_map.clear();
        self.opus_decoders.clear();
        self.last_rtp_seq.clear();
        self.speaking_states.clear();
        self.opus_pcm_scratch.fill(0);
        self.remote_video_states
            .retain(|(role, _), _| *role != TransportRole::Voice);
        for ((role, _), subscription) in &mut self.user_video_subscriptions {
            if *role == TransportRole::Voice {
                subscription.reset_runtime();
            }
        }
        self.video_decode_worker.clear_role(TransportRole::Voice);

        tracing::info!(
            reason = reason,
            cleared_audio_ssrcs,
            cleared_decoders,
            cleared_speaking_users,
            cleared_capture_users,
            "cleared primary voice runtime state"
        );
    }

    pub(crate) fn clear_primary_playback(&mut self, reason: &str) {
        let music_id = self.music.music_id.clone();
        self.music.reset();
        drain_music_pcm_queue(&self.music_pcm_rx);
        clear_audio_send_buffer(&self.audio_send_state);
        if let Some(playback_id) = self.tts_playback_id.take() {
            send_tts_playback_state(&playback_id, TtsPlaybackStatus::Stopped, Some(reason));
        }
        self.tts_finish_pending = false;
        self.tts_playback_buffered = false;
        self.tts_playback_started = false;
        self.buffer_depth_was_nonempty = false;
        if let Some(music_id) = music_id {
            send_msg(OutMsg::PlayerState {
                status: "idle".into(),
                music_id: Some(music_id.clone()),
            });
            send_msg(OutMsg::MusicIdle { music_id });
        }
    }

    pub(crate) fn remove_user_runtime_state(&mut self, user_id: u64) {
        let removed_ssrcs = self
            .ssrc_map
            .iter()
            .filter_map(|(&ssrc, &mapped_uid)| (mapped_uid == user_id).then_some(ssrc))
            .collect::<Vec<_>>();
        self.ssrc_map.retain(|_, v| *v != user_id);
        for ssrc in removed_ssrcs {
            self.opus_decoders.remove(&ssrc);
            self.last_rtp_seq.remove(&ssrc);
        }

        let uid_str = user_id.to_string();
        if let Some(ss) = self.speaking_states.remove(&user_id)
            && ss.is_speaking
        {
            send_msg(OutMsg::SpeakingEnd {
                user_id: uid_str.clone(),
                capture_id: self
                    .user_capture_states
                    .get(&user_id)
                    .map(|capture| capture.capture_id.clone()),
            });
        }

        if let Some(state) = self.user_capture_states.remove(&user_id)
            && state.stream_active
        {
            send_msg(OutMsg::UserAudioEnd {
                user_id: uid_str.clone(),
                capture_id: state.capture_id,
            });
        }

        self.video_decode_worker
            .remove_user(TransportRole::Voice, user_id);
        self.remote_video_states
            .remove(&(TransportRole::Voice, user_id));

        send_msg(OutMsg::ClientDisconnect { user_id: uid_str });
    }

    pub(crate) fn handle_disconnected(&mut self, reason: &str) {
        tracing::warn!("Voice disconnected: {}", reason);
        send_transport_error(
            ErrorCode::VoiceRuntimeError,
            TransportRole::Voice,
            self.connection_id.as_deref(),
            reason.to_string(),
        );
        if let Some(connection_id) = self.connection_id.clone() {
            send_msg(OutMsg::ConnectionState {
                status: "disconnected".into(),
                connection_id,
            });
        }
        self.emit_transport_state(TransportRole::Voice, "disconnected", Some(reason));
        self.clear_primary_playback(reason);
        self.clear_voice_connection();
        self.clear_primary_runtime_state(reason);

        self.schedule_reconnect(reason);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TryConnectOutcome {
    AlreadyConnected,
    MissingData,
    Connected,
    Failed,
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crossbeam_channel as crossbeam;
    use parking_lot::Mutex;
    use tokio::sync::mpsc;

    use crate::audio_pipeline::AudioSendState;
    use crate::capture::SpeakingState;
    use crate::dave::DaveManager;
    use crate::music::{MusicEvent, MusicPcm};
    use crate::stream_publish::{StreamPublishEvent, StreamPublishFrame};
    use crate::video::{RemoteVideoState, UserVideoSubscription, VideoStreamDescriptor};
    use crate::voice_conn::VoiceEvent;

    use super::AppState;

    fn test_app_state() -> AppState {
        let dave: Arc<Mutex<Option<DaveManager>>> = Arc::new(Mutex::new(None));
        let (voice_event_tx, _voice_event_rx) = mpsc::channel::<VoiceEvent>(4);
        let audio_send_state = Arc::new(Mutex::new(None::<AudioSendState>));
        let (music_pcm_tx, music_pcm_rx) = crossbeam::bounded::<MusicPcm>(4);
        let (music_event_tx, _music_event_rx) = mpsc::channel::<MusicEvent>(4);
        let (stream_publish_frame_tx, stream_publish_frame_rx) =
            crossbeam::bounded::<StreamPublishFrame>(4);
        let (stream_publish_event_tx, stream_publish_event_rx) =
            crossbeam::bounded::<StreamPublishEvent>(4);

        AppState::new(
            dave,
            voice_event_tx,
            audio_send_state,
            music_pcm_tx,
            music_pcm_rx,
            music_event_tx,
            stream_publish_frame_tx,
            stream_publish_frame_rx,
            stream_publish_event_tx,
            stream_publish_event_rx,
        )
    }

    #[test]
    fn clear_transport_runtime_state_drops_transport_state_but_keeps_subscriptions() {
        let mut state = test_app_state();
        state.ssrc_map.insert(111, 42);
        state.speaking_states.insert(
            42,
            SpeakingState {
                last_packet_at: None,
                is_speaking: true,
            },
        );
        state.user_video_subscriptions.insert(
            (crate::voice_conn::TransportRole::Voice, 42),
            UserVideoSubscription::new(15, 80, Some(1_280 * 720), Some("screen".into()), None),
        );
        state.remote_video_states.insert(
            (crate::voice_conn::TransportRole::Voice, 42),
            RemoteVideoState {
                audio_ssrc: Some(211),
                video_ssrc: Some(311),
                codec: Some("h264".into()),
                streams: vec![VideoStreamDescriptor {
                    ssrc: 311,
                    rtx_ssrc: Some(411),
                    rid: Some("f".into()),
                    quality: Some(100),
                    stream_type: Some("screen".into()),
                    active: Some(true),
                    max_bitrate: Some(4_000_000),
                    max_framerate: Some(30),
                    max_resolution: None,
                }],
            },
        );

        state.clear_primary_runtime_state("test");

        assert!(state.ssrc_map.is_empty());
        assert!(state.opus_decoders.is_empty());
        assert!(state.speaking_states.is_empty());
        assert!(state.remote_video_states.is_empty());
        assert!(
            state
                .user_video_subscriptions
                .contains_key(&(crate::voice_conn::TransportRole::Voice, 42))
        );
    }

    #[test]
    fn primary_disconnect_does_not_reset_stream_roles() {
        let mut state = test_app_state();
        state.guild_id = Some(1);
        state.channel_id = Some(2);
        state.stream_watch_pending_conn.endpoint = Some("watch.example".into());
        state.stream_publish_pending_conn.endpoint = Some("publish.example".into());
        state.stream_publish.active = true;

        state.handle_disconnected("voice_socket_closed");

        assert_eq!(
            state.stream_watch_pending_conn.endpoint.as_deref(),
            Some("watch.example")
        );
        assert_eq!(
            state.stream_publish_pending_conn.endpoint.as_deref(),
            Some("publish.example")
        );
        assert!(state.stream_publish.active);
    }

    #[test]
    fn stale_events_are_ignored_and_dave_readiness_is_monotonic() {
        let mut state = test_app_state();
        state.connection_id = Some("connection-new".into());
        let current = state.begin_transport_generation(crate::voice_conn::TransportRole::Voice);

        state.handle_voice_event(VoiceEvent::Ready {
            role: crate::voice_conn::TransportRole::Voice,
            generation: current - 1,
            ssrc: 1,
            dave_protocol_version: 1,
        });
        assert!(state.audio_send_state.lock().is_none());

        state.handle_voice_event(VoiceEvent::DaveReady {
            role: crate::voice_conn::TransportRole::Voice,
            generation: current,
            protocol_version: 1,
        });
        assert_eq!(
            state.dave_ready_protocol_version(crate::voice_conn::TransportRole::Voice),
            None
        );

        state.handle_voice_event(VoiceEvent::Ready {
            role: crate::voice_conn::TransportRole::Voice,
            generation: current,
            ssrc: 2,
            dave_protocol_version: 1,
        });
        assert!(state.audio_send_state.lock().is_some());
        assert_eq!(
            state.dave_ready_protocol_version(crate::voice_conn::TransportRole::Voice),
            Some(1)
        );

        state.handle_voice_event(VoiceEvent::Ready {
            role: crate::voice_conn::TransportRole::Voice,
            generation: current,
            ssrc: 2,
            dave_protocol_version: 1,
        });
        assert_eq!(
            state.dave_ready_protocol_version(crate::voice_conn::TransportRole::Voice),
            Some(1),
            "a later Ready event must not regress DAVE to negotiating",
        );
    }

    #[test]
    fn concurrent_voice_and_watch_video_state_are_role_isolated() {
        let mut state = test_app_state();
        let voice = crate::voice_conn::TransportRole::Voice;
        let watch = crate::voice_conn::TransportRole::StreamWatch;
        let camera = VideoStreamDescriptor {
            ssrc: 3_001,
            rtx_ssrc: None,
            rid: None,
            quality: Some(100),
            stream_type: Some("video".into()),
            active: Some(true),
            max_bitrate: None,
            max_framerate: None,
            max_resolution: None,
        };
        let screen = VideoStreamDescriptor {
            ssrc: 4_001,
            stream_type: Some("screen".into()),
            ..camera.clone()
        };

        state.handle_voice_event(VoiceEvent::VideoStateUpdate {
            role: voice,
            generation: state.current_transport_generation(voice),
            user_id: 42,
            audio_ssrc: Some(2_001),
            video_ssrc: Some(camera.ssrc),
            codec: Some("h264".into()),
            streams: vec![camera],
        });
        state.handle_voice_event(VoiceEvent::VideoStateUpdate {
            role: watch,
            generation: state.current_transport_generation(watch),
            user_id: 42,
            audio_ssrc: None,
            video_ssrc: Some(screen.ssrc),
            codec: Some("h264".into()),
            streams: vec![screen],
        });

        assert!(state.remote_video_states.contains_key(&(voice, 42)));
        assert!(state.remote_video_states.contains_key(&(watch, 42)));

        state.handle_voice_event(VoiceEvent::ClientDisconnect {
            role: voice,
            generation: state.current_transport_generation(voice),
            user_id: 42,
        });
        assert!(!state.remote_video_states.contains_key(&(voice, 42)));
        assert!(state.remote_video_states.contains_key(&(watch, 42)));
    }
}
