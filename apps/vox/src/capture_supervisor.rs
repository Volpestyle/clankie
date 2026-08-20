use std::collections::BTreeMap;
use std::collections::hash_map::Entry;
use std::sync::atomic::Ordering;

use audiopus::coder::Decoder as OpusDecoder;
use audiopus::packet::Packet as OpusPacket;
use audiopus::{Channels, MutSignals, SampleRate};
use base64::Engine as _;
use tokio::time;

use crate::app_state::{AppState, transport_stats};
use crate::capture::{
    SPEAKING_TIMEOUT_MS, SpeakingState, UserCaptureState, normalize_sample_rate,
    normalize_silence_duration_ms,
};
use crate::ipc::{DaveStateStatus, ErrorCode, InMsg, OutMsg, send_error, send_msg};
use crate::video::{RemoteVideoState, UserVideoSubscription};
use crate::voice_conn::{TransportRole, VoiceEvent};

/// Maximum number of lost RTP packets for which we attempt FEC/PLC recovery.
/// Gaps larger than this are likely DTX silence periods or reconnects —
/// concealment would produce garbage.
const MAX_RECOVERABLE_GAP: i16 = 5;

/// Worst-case Opus decode output: 120ms at 48kHz stereo.  Sizes the reusable
/// decode scratch buffer on [`AppState`].
pub(crate) const OPUS_DECODE_MAX_SAMPLES: usize = 5760;

const FIRST_KEYFRAME_REASSERT_INTERVAL_MS: u64 = 2_000;
/// Interval between periodic PLI requests after the first keyframe has been
/// received. Periodic PLI gives the decoder regular opportunities to resync
/// via IDR frames.
const PERIODIC_KEYFRAME_PLI_INTERVAL_MS: u64 = 2_000;

/// Classification of an incoming RTP sequence number relative to the last
/// accepted packet for the same SSRC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RtpSeqClass {
    /// First packet for this SSRC — no history yet.
    First,
    /// Next expected sequence — no loss.
    Sequential,
    /// Forward gap: `lost_count` packets were skipped (1..=MAX_RECOVERABLE_GAP).
    ForwardLoss { lost_count: u16 },
    /// Forward gap too large to recover — likely DTX or reconnect.
    ForwardLarge,
    /// Duplicate of the last accepted packet.
    Duplicate,
    /// Stale / reordered — a packet older than the last accepted.
    Stale,
}

/// Classify an incoming RTP sequence relative to the last accepted one.
///
/// Uses signed distance (i16 cast of wrapping_sub) to correctly handle u16
/// wraparound. Positive distance = forward gap; negative = stale/reordered.
fn classify_rtp_sequence(prev_seq: Option<u16>, incoming: u16) -> RtpSeqClass {
    let Some(prev) = prev_seq else {
        return RtpSeqClass::First;
    };
    let expected = prev.wrapping_add(1);
    if incoming == expected {
        return RtpSeqClass::Sequential;
    }
    if incoming == prev {
        return RtpSeqClass::Duplicate;
    }
    // Signed distance: positive means the incoming packet is ahead of expected,
    // negative means it is behind (stale/reordered).
    let distance = incoming.wrapping_sub(expected) as i16;
    if distance > 0 && distance <= MAX_RECOVERABLE_GAP {
        RtpSeqClass::ForwardLoss {
            lost_count: distance as u16,
        }
    } else if distance > MAX_RECOVERABLE_GAP {
        RtpSeqClass::ForwardLarge
    } else {
        // distance <= 0 (or very large u16 wrapping → negative i16)
        RtpSeqClass::Stale
    }
}

fn update_speaking_state(
    speaking_states: &mut std::collections::HashMap<u64, SpeakingState>,
    user_id: u64,
    now: time::Instant,
) -> bool {
    let speaking = speaking_states.entry(user_id).or_insert(SpeakingState {
        last_packet_at: None,
        is_speaking: false,
    });
    speaking.last_packet_at = Some(now);
    if speaking.is_speaking {
        false
    } else {
        speaking.is_speaking = true;
        true
    }
}

fn should_reassert_sink_wants_for_waiting_keyframe(
    subscription: &mut UserVideoSubscription,
    keyframe: bool,
    now: time::Instant,
) -> bool {
    if keyframe {
        subscription.last_keyframe_forwarded_at = Some(now);
        subscription.last_sink_wants_reasserted_at = None;
        return false;
    }

    // Before first keyframe: request aggressively at 2s intervals
    let interval_ms = if subscription.last_keyframe_forwarded_at.is_some() {
        // After first keyframe: request periodically so the per-frame
        // decoder gets fresh independently-decodable keyframes for the
        // vision scanner.
        PERIODIC_KEYFRAME_PLI_INTERVAL_MS
    } else {
        FIRST_KEYFRAME_REASSERT_INTERVAL_MS
    };
    let reassert_interval = std::time::Duration::from_millis(interval_ms);
    match subscription.last_sink_wants_reasserted_at {
        Some(last_reasserted_at) if now.duration_since(last_reasserted_at) < reassert_interval => {
            false
        }
        _ => {
            subscription.last_sink_wants_reasserted_at = Some(now);
            true
        }
    }
}

impl AppState {
    fn remove_user_video_runtime_state(&mut self, role: TransportRole, user_id: u64) {
        self.remote_video_states.remove(&(role, user_id));
        self.video_decode_worker.remove_user(role, user_id);
    }

    fn refresh_video_sink_wants(&self, reason: &str) {
        if self.voice_conn.is_none() && self.stream_watch_conn.is_none() {
            tracing::info!(
                reason = reason,
                subscribed_user_count = self.user_video_subscriptions.len(),
                remote_video_user_count = self.remote_video_states.len(),
                "clankvox_video_sink_wants_skipped_no_connection"
            );
            return;
        }

        // Keep remote state and feedback on the transport that produced it.
        // A user's webcam and screen share may be live on separate roles with
        // overlapping metadata, so stream type must never reroute a binding.
        let mut voice_wants: BTreeMap<u32, u8> = BTreeMap::new();
        let mut voice_pixels: BTreeMap<u32, f64> = BTreeMap::new();
        let mut sw_wants: BTreeMap<u32, u8> = BTreeMap::new();
        let mut sw_pixels: BTreeMap<u32, f64> = BTreeMap::new();
        for (&(role, user_id), remote_state) in &self.remote_video_states {
            let (wants, pixels) = match role {
                TransportRole::Voice => (&mut voice_wants, &mut voice_pixels),
                TransportRole::StreamWatch => (&mut sw_wants, &mut sw_pixels),
                TransportRole::StreamPublish => continue,
            };
            // Mark all known SSRCs as "quality 0" (= don't send but
            // acknowledge existence) on the originating transport.
            for stream in &remote_state.streams {
                wants.entry(stream.ssrc).or_insert(0);
            }
            if let Some(video_ssrc) = remote_state.video_ssrc {
                wants.entry(video_ssrc).or_insert(0);
            }

            let Some(subscription) = self.user_video_subscriptions.get(&(role, user_id)) else {
                continue;
            };

            if let Some(stream) = remote_state.preferred_stream(subscription) {
                wants.insert(stream.ssrc, subscription.preferred_quality);
                if let Some(pixel_count) = subscription
                    .preferred_pixel_count
                    .or_else(|| stream.pixel_count_hint())
                {
                    pixels.insert(stream.ssrc, f64::from(pixel_count));
                }
            } else if let Some(video_ssrc) = remote_state.video_ssrc {
                wants.insert(video_ssrc, subscription.preferred_quality);
                if let Some(pixel_count) = subscription.preferred_pixel_count {
                    pixels.insert(video_ssrc, f64::from(pixel_count));
                }
            }
        }

        // Send wants to each transport that has entries.
        let voice_wants_vec = voice_wants.into_iter().collect::<Vec<_>>();
        let voice_pixels_vec = voice_pixels.into_iter().collect::<Vec<_>>();
        let sw_wants_vec = sw_wants.into_iter().collect::<Vec<_>>();
        let sw_pixels_vec = sw_pixels.into_iter().collect::<Vec<_>>();

        let total_wanted = voice_wants_vec.len() + sw_wants_vec.len();
        tracing::info!(
            reason = reason,
            subscribed_user_count = self.user_video_subscriptions.len(),
            remote_video_user_count = self.remote_video_states.len(),
            wanted_ssrc_count = total_wanted,
            wanted_streams = ?voice_wants_vec,
            sw_wanted_streams = ?sw_wants_vec,
            pixel_count_overrides = ?voice_pixels_vec,
            "clankvox_video_sink_wants_updated"
        );

        if !voice_wants_vec.is_empty()
            && let Some(conn) = self.voice_conn.as_ref()
            && let Err(error) = conn.update_media_sink_wants(&voice_wants_vec, &voice_pixels_vec)
        {
            tracing::warn!(reason = reason, error = %error, "failed to update voice media sink wants");
        }
        if !sw_wants_vec.is_empty()
            && let Some(conn) = self.stream_watch_conn.as_ref()
            && let Err(error) = conn.update_media_sink_wants(&sw_wants_vec, &sw_pixels_vec)
        {
            tracing::warn!(reason = reason, error = %error, "failed to update stream_watch media sink wants");
        }
    }

    fn request_video_keyframes(&self, role: TransportRole) {
        if role != TransportRole::StreamWatch && role != TransportRole::Voice {
            return;
        }
        let Some(conn) = self.connection_for_role(role) else {
            return;
        };
        for remote_state in self
            .remote_video_states
            .iter()
            .filter_map(|(&(state_role, _), state)| (state_role == role).then_some(state))
        {
            for stream in &remote_state.streams {
                tracing::info!(
                    role = role.as_str(),
                    ssrc = stream.ssrc,
                    "clankvox_dave_ready_pli_requesting_keyframe"
                );
                if let Err(error) = conn.send_rtcp_pli(stream.ssrc) {
                    tracing::warn!(
                        ssrc = stream.ssrc,
                        error = %error,
                        "clankvox_dave_ready_pli_failed"
                    );
                }
            }
            if let Some(video_ssrc) = remote_state.video_ssrc
                && !remote_state
                    .streams
                    .iter()
                    .any(|stream| stream.ssrc == video_ssrc)
            {
                tracing::info!(
                    role = role.as_str(),
                    ssrc = video_ssrc,
                    "clankvox_dave_ready_pli_requesting_keyframe"
                );
                if let Err(error) = conn.send_rtcp_pli(video_ssrc) {
                    tracing::warn!(
                        ssrc = video_ssrc,
                        error = %error,
                        "clankvox_dave_ready_pli_failed"
                    );
                }
            }
        }
    }

    pub(crate) fn handle_capture_command(&mut self, msg: InMsg) {
        match msg {
            InMsg::SubscribeUser {
                user_id,
                capture_id,
                silence_duration_ms,
                sample_rate,
            } => {
                let Some(user_id) =
                    crate::app_state::parse_user_id_field(&user_id, "subscribe_user")
                else {
                    return;
                };
                if capture_id.is_empty() || capture_id.len() > usize::from(u16::MAX) {
                    send_error(
                        ErrorCode::InvalidRequest,
                        "subscribe_user requires a captureId between 1 and 65535 UTF-8 bytes",
                    );
                    return;
                }
                let sample_rate = normalize_sample_rate(sample_rate);
                let silence_duration_ms = normalize_silence_duration_ms(silence_duration_ms);
                if let Some(previous) = self.user_capture_states.insert(
                    user_id,
                    UserCaptureState::new(capture_id, sample_rate, silence_duration_ms),
                ) && previous.stream_active
                {
                    send_msg(OutMsg::UserAudioEnd {
                        user_id: user_id.to_string(),
                        capture_id: previous.capture_id,
                    });
                }
            }
            InMsg::UnsubscribeUser { user_id } => {
                let Some(user_id) =
                    crate::app_state::parse_user_id_field(&user_id, "unsubscribe_user")
                else {
                    return;
                };
                if let Some(state) = self.user_capture_states.remove(&user_id)
                    && state.stream_active
                {
                    send_msg(OutMsg::UserAudioEnd {
                        user_id: user_id.to_string(),
                        capture_id: state.capture_id,
                    });
                }
            }
            InMsg::SubscribeUserVideo {
                user_id,
                max_frames_per_second,
                preferred_quality,
                preferred_pixel_count,
                preferred_stream_type,
                jpeg_quality,
            } => {
                let Some(user_id) =
                    crate::app_state::parse_user_id_field(&user_id, "subscribe_user_video")
                else {
                    return;
                };
                let subscription = UserVideoSubscription::new(
                    max_frames_per_second,
                    preferred_quality,
                    preferred_pixel_count,
                    preferred_stream_type,
                    jpeg_quality,
                );
                let had_cached_remote_state = self
                    .remote_video_states
                    .keys()
                    .any(|(_, remote_user_id)| *remote_user_id == user_id);
                tracing::info!(
                    user_id,
                    max_frames_per_second = subscription.max_frames_per_second,
                    preferred_quality = subscription.preferred_quality,
                    preferred_pixel_count = subscription.preferred_pixel_count,
                    preferred_stream_type = ?subscription.preferred_stream_type.as_deref(),
                    had_cached_remote_state,
                    "clankvox_native_video_subscribe_requested"
                );
                self.user_video_subscriptions
                    .insert((TransportRole::Voice, user_id), subscription.clone());
                self.user_video_subscriptions
                    .insert((TransportRole::StreamWatch, user_id), subscription);
                self.refresh_video_sink_wants("subscribe_user_video");
            }
            InMsg::UnsubscribeUserVideo { user_id } => {
                let Some(user_id) =
                    crate::app_state::parse_user_id_field(&user_id, "unsubscribe_user_video")
                else {
                    return;
                };
                let before = self.user_video_subscriptions.len();
                self.user_video_subscriptions
                    .retain(|(_, subscribed_user_id), _| *subscribed_user_id != user_id);
                let had_subscription = self.user_video_subscriptions.len() != before;
                tracing::info!(
                    user_id,
                    had_subscription,
                    "clankvox_native_video_unsubscribe_requested"
                );
                self.refresh_video_sink_wants("unsubscribe_user_video");
            }
            _ => unreachable!("non-capture IPC command routed to capture supervisor"),
        }
    }

    pub(crate) fn handle_voice_event(&mut self, event: VoiceEvent) {
        if !self.is_current_voice_event(&event) {
            tracing::debug!(
                role = event.role().as_str(),
                event_generation = event.generation(),
                current_generation = self.current_transport_generation(event.role()),
                "ignoring stale transport event"
            );
            return;
        }
        match event {
            VoiceEvent::Ready {
                role,
                generation: _,
                ssrc,
                dave_protocol_version,
            } => {
                let (first_ready, pending_dave_ready) = self.mark_transport_ready(role);
                if !first_ready {
                    return;
                }
                tracing::info!(role = role.as_str(), ssrc, "Transport ready");
                match role {
                    TransportRole::Voice => {
                        let Some(connection_id) = self.connection_id.clone() else {
                            tracing::error!("ignoring primary Ready without a join connectionId");
                            return;
                        };
                        self.reset_reconnect();
                        send_msg(OutMsg::ConnectionState {
                            status: "ready".into(),
                            connection_id: connection_id.clone(),
                        });
                        self.emit_transport_state(TransportRole::Voice, "ready", None);
                        send_msg(OutMsg::Ready { connection_id });

                        match crate::audio_pipeline::AudioSendState::new() {
                            Ok(state) => {
                                *self.audio_send_state.lock() = Some(state);
                                crate::audio_pipeline::emit_playback_armed(
                                    "connection_ready",
                                    &self.audio_send_state,
                                );
                            }
                            Err(error) => {
                                tracing::error!("Failed to init audio send state: {}", error)
                            }
                        }
                    }
                    TransportRole::StreamWatch => {
                        self.emit_transport_state(TransportRole::StreamWatch, "ready", None);
                    }
                    TransportRole::StreamPublish => {
                        self.emit_transport_state(TransportRole::StreamPublish, "ready", None);
                        self.maybe_start_stream_publish_pipeline();
                    }
                }
                if let Some(protocol_version) = pending_dave_ready {
                    self.emit_dave_state(role, DaveStateStatus::Ready, Some(protocol_version));
                    self.request_video_keyframes(role);
                } else if self.dave_ready_protocol_version(role).is_none() {
                    self.emit_dave_state(
                        role,
                        if dave_protocol_version > 0 {
                            DaveStateStatus::Negotiating
                        } else {
                            DaveStateStatus::Disabled
                        },
                        Some(dave_protocol_version),
                    );
                }
                self.refresh_video_sink_wants(match role {
                    TransportRole::Voice => "voice_ready",
                    TransportRole::StreamWatch => "stream_watch_ready",
                    TransportRole::StreamPublish => "stream_publish_ready",
                });
            }
            VoiceEvent::SsrcUpdate {
                role,
                generation: _,
                ssrc,
                user_id,
            } => {
                if role == TransportRole::Voice
                    && self.ssrc_map.insert(ssrc, user_id) != Some(user_id)
                {
                    self.opus_decoders.remove(&ssrc);
                    self.last_rtp_seq.remove(&ssrc);
                }
            }
            VoiceEvent::VideoStateUpdate {
                role,
                generation: _,
                user_id,
                audio_ssrc,
                video_ssrc,
                codec,
                streams,
            } => {
                if self.is_self_user(role, user_id) {
                    return;
                }

                let key = (role, user_id);
                let previous = self.remote_video_states.get(&key).cloned();
                let clear_video_state = video_ssrc.is_none() && streams.is_empty();
                let incoming_stream_ssrcs =
                    streams.iter().map(|stream| stream.ssrc).collect::<Vec<_>>();
                let incoming_active_stream_count =
                    streams.iter().filter(|stream| stream.is_active()).count();
                let previous_stream_count = previous
                    .as_ref()
                    .map(|state| state.streams.len())
                    .unwrap_or_default();
                tracing::info!(
                    user_id,
                    clear_video_state,
                    audio_ssrc = audio_ssrc,
                    video_ssrc = video_ssrc,
                    codec = ?codec.as_deref(),
                    incoming_stream_count = streams.len(),
                    incoming_active_stream_count,
                    incoming_stream_ssrcs = ?incoming_stream_ssrcs,
                    previous_stream_count,
                    "clankvox_native_video_state_received"
                );
                let state = RemoteVideoState {
                    audio_ssrc: if clear_video_state {
                        None
                    } else {
                        audio_ssrc.or_else(|| previous.as_ref().and_then(|state| state.audio_ssrc))
                    },
                    video_ssrc: if clear_video_state {
                        None
                    } else {
                        video_ssrc.or_else(|| previous.as_ref().and_then(|state| state.video_ssrc))
                    },
                    codec: if clear_video_state {
                        None
                    } else {
                        codec.or_else(|| previous.as_ref().and_then(|state| state.codec.clone()))
                    },
                    streams: if clear_video_state {
                        Vec::new()
                    } else if streams.is_empty() {
                        previous
                            .as_ref()
                            .map(|state| state.streams.clone())
                            .unwrap_or_default()
                    } else {
                        streams
                    },
                };

                if state.has_streams() {
                    self.remote_video_states.insert(key, state);
                } else {
                    self.remote_video_states.remove(&key);
                }

                self.refresh_video_sink_wants(match role {
                    TransportRole::Voice => "video_state_update",
                    TransportRole::StreamWatch => "stream_watch_video_state_update",
                    TransportRole::StreamPublish => "stream_publish_video_state_update",
                });
            }
            VoiceEvent::ClientDisconnect {
                role,
                generation: _,
                user_id,
            } => {
                if !self.is_self_user(role, user_id) {
                    match role {
                        TransportRole::Voice => self.remove_user_runtime_state(user_id),
                        TransportRole::StreamWatch => {
                            self.remove_user_video_runtime_state(role, user_id);
                        }
                        TransportRole::StreamPublish => {}
                    }
                    self.refresh_video_sink_wants(match role {
                        TransportRole::Voice => "client_disconnect",
                        TransportRole::StreamWatch => "stream_watch_client_disconnect",
                        TransportRole::StreamPublish => "stream_publish_client_disconnect",
                    });
                }
            }
            VoiceEvent::OpusReceived {
                role,
                generation: _,
                ssrc,
                opus_frame,
                rtp_sequence,
            } => {
                if role != TransportRole::Voice {
                    return;
                }
                let Some(&user_id) = self.ssrc_map.get(&ssrc) else {
                    tracing::debug!("Dropped Opus frame from unknown ssrc: {ssrc}");
                    return;
                };
                if self.is_self_user(role, user_id) {
                    return;
                }

                // --- RTP sequence classification ---
                let seq_class =
                    classify_rtp_sequence(self.last_rtp_seq.get(&ssrc).copied(), rtp_sequence);

                // Drop stale and duplicate packets — feeding them to the
                // decoder would corrupt its internal state and produce
                // out-of-order or doubled audio.  Speaking state is NOT
                // updated for these packets so that duplicates/reorders
                // cannot artificially stretch SpeakingStart/SpeakingEnd timing.
                match seq_class {
                    RtpSeqClass::Duplicate => {
                        tracing::debug!(ssrc, rtp_sequence, "Dropped duplicate RTP packet");
                        return;
                    }
                    RtpSeqClass::Stale => {
                        tracing::debug!(ssrc, rtp_sequence, "Dropped stale/reordered RTP packet");
                        return;
                    }
                    _ => {}
                }

                // Speaking state is updated only after duplicate/stale
                // filtering so that discarded packets cannot stretch
                // speaking activity.  This fires BEFORE the user_capture_states
                // gate so that the initial SpeakingStart reaches TypeScript and
                // triggers subscribe_user (bootstrap).
                if update_speaking_state(&mut self.speaking_states, user_id, time::Instant::now()) {
                    send_msg(OutMsg::SpeakingStart {
                        user_id: user_id.to_string(),
                        capture_id: self
                            .user_capture_states
                            .get(&user_id)
                            .map(|capture| capture.capture_id.clone()),
                    });
                }

                // Gate audio decode/forwarding on subscription — only users
                // that TypeScript has subscribed via subscribe_user get their
                // Opus decoded and forwarded as UserAudio PCM.
                let Some(state) = self.user_capture_states.get(&user_id) else {
                    return;
                };
                let target_sample_rate = state.sample_rate;
                let capture_id = state.capture_id.clone();

                // Ensure an Opus decoder exists for this SSRC.
                if let Entry::Vacant(entry) = self.opus_decoders.entry(ssrc) {
                    let decoder = match OpusDecoder::new(SampleRate::Hz48000, Channels::Stereo) {
                        Ok(decoder) => decoder,
                        Err(error) => {
                            tracing::error!(
                                "failed to init Opus decoder for ssrc={}: {:?}",
                                ssrc,
                                error
                            );
                            return;
                        }
                    };
                    entry.insert(decoder);
                }

                let decoder = self
                    .opus_decoders
                    .get_mut(&ssrc)
                    .expect("decoder inserted above");

                // Helper: convert decoded stereo PCM to LLM-ready output.
                let convert_frame = |decoded: &[i16], target_sample_rate: u32| {
                    crate::audio_pipeline::convert_decoded_to_llm(decoded, target_sample_rate)
                };

                // --- FEC / PLC for forward packet loss ---
                // Recovery frames are buffered (not emitted) until the
                // current anchor packet decodes successfully. If the anchor
                // fails, the recovery audio is discarded so we never emit
                // orphaned concealment frames without the real packet that
                // anchors them.
                // All decode passes below share the reusable scratch buffer;
                // each pass's output is converted (copied out) before the next
                // decode overwrites it.
                let mut recovery_frames: Vec<(Vec<u8>, u16, usize, usize)> = Vec::new();
                if let RtpSeqClass::ForwardLoss { lost_count } = seq_class {
                    let transport = transport_stats();
                    transport
                        .inbound_audio_forward_loss_gaps
                        .fetch_add(u64::from(lost_count), Ordering::Relaxed);
                    let plc_count = lost_count.saturating_sub(1) as usize;
                    if plc_count > 0 {
                        tracing::debug!(
                            ssrc,
                            lost_count,
                            plc_count,
                            "Opus PLC: synthesizing {plc_count} concealment frame(s)"
                        );
                    }
                    for _ in 0..plc_count {
                        let plc_signals =
                            MutSignals::try_from(self.opus_pcm_scratch.as_mut_slice())
                                .expect("non-empty signal buffer");
                        if let Ok(plc_samples) = decoder.decode(None, plc_signals, false) {
                            let total = plc_samples * 2;
                            recovery_frames.push(convert_frame(
                                &self.opus_pcm_scratch[..total],
                                target_sample_rate,
                            ));
                            transport
                                .inbound_audio_concealed_frames
                                .fetch_add(1, Ordering::Relaxed);
                        }
                    }

                    // Recover the frame immediately before the current packet
                    // using in-band FEC.
                    let fec_packet = match OpusPacket::try_from(opus_frame.as_slice()) {
                        Ok(p) => p,
                        Err(error) => {
                            tracing::debug!("Invalid Opus packet (FEC) ssrc={}: {:?}", ssrc, error);
                            return;
                        }
                    };
                    let fec_signals = MutSignals::try_from(self.opus_pcm_scratch.as_mut_slice())
                        .expect("non-empty signal buffer");
                    if let Ok(fec_samples) = decoder.decode(Some(fec_packet), fec_signals, true) {
                        let total = fec_samples * 2;
                        recovery_frames.push(convert_frame(
                            &self.opus_pcm_scratch[..total],
                            target_sample_rate,
                        ));
                        transport
                            .inbound_audio_concealed_frames
                            .fetch_add(1, Ordering::Relaxed);
                        tracing::debug!(ssrc, lost_count, "Opus FEC: recovered prior frame");
                    }
                }

                // --- Normal decode of the current packet ---
                let decode_result = {
                    let packet = match OpusPacket::try_from(opus_frame.as_slice()) {
                        Ok(packet) => packet,
                        Err(error) => {
                            tracing::debug!("Invalid Opus packet for ssrc={}: {:?}", ssrc, error);
                            return;
                        }
                    };
                    let signals = MutSignals::try_from(self.opus_pcm_scratch.as_mut_slice())
                        .expect("non-empty signal buffer");
                    decoder.decode(Some(packet), signals, false)
                };

                match decode_result {
                    Ok(samples_per_channel) => {
                        // Anchor decode succeeded — emit any buffered recovery
                        // frames first (in chronological order), then the
                        // current packet.
                        for (pcm, peak, active, total) in recovery_frames {
                            if !pcm.is_empty() {
                                send_msg(OutMsg::UserAudio {
                                    user_id: user_id.to_string(),
                                    capture_id: capture_id.clone(),
                                    pcm,
                                    signal_peak_abs: peak,
                                    signal_active_sample_count: active,
                                    signal_sample_count: total,
                                });
                            }
                        }

                        let total_samples = samples_per_channel * 2;
                        let (llm_pcm, peak, active, total) = convert_frame(
                            &self.opus_pcm_scratch[..total_samples],
                            target_sample_rate,
                        );
                        if !llm_pcm.is_empty() {
                            send_msg(OutMsg::UserAudio {
                                user_id: user_id.to_string(),
                                capture_id,
                                pcm: llm_pcm,
                                signal_peak_abs: peak,
                                signal_active_sample_count: active,
                                signal_sample_count: total,
                            });
                        }

                        // Only advance the sequence tracker after a successful
                        // decode — failed decodes should not corrupt gap detection.
                        self.last_rtp_seq.insert(ssrc, rtp_sequence);

                        if let Some(state) = self.user_capture_states.get_mut(&user_id) {
                            state.touch_audio(time::Instant::now());
                        }
                    }
                    Err(error) => {
                        // Anchor decode failed — discard buffered recovery
                        // frames (they were decoded into the Opus decoder's
                        // state but we do not emit them without a valid anchor).
                        if !recovery_frames.is_empty() {
                            tracing::debug!(
                                ssrc,
                                rtp_sequence,
                                recovery_count = recovery_frames.len(),
                                "Opus anchor decode failed; discarding {count} recovery frame(s)",
                                count = recovery_frames.len()
                            );
                        }
                        for (pcm, _, _, _) in &mut recovery_frames {
                            pcm.fill(0);
                        }
                        tracing::debug!("Opus decode error for ssrc={}: {:?}", ssrc, error);
                    }
                }
            }
            VoiceEvent::VideoFrameReceived {
                role,
                generation,
                user_id,
                ssrc,
                codec,
                keyframe,
                frame,
                rtp_timestamp,
                stream_type,
                rid,
                dave_decrypted,
            } => {
                if self.is_self_user(role, user_id) {
                    return;
                }

                if !self.user_video_subscriptions.contains_key(&(role, user_id)) {
                    return;
                }

                let is_h264 = codec.eq_ignore_ascii_case("h264");

                if is_h264 {
                    // ── Persistent H264 decode path ──
                    //
                    // Decode is delegated to the dedicated worker thread —
                    // openh264 + YUV→RGB + turbojpeg per frame would stall
                    // the event loop.  The worker feeds EVERY frame to the
                    // decoder so reference state stays intact, runs the fps
                    // gate before the JPEG encode, and emits the
                    // decoded_video_frame IPC message itself.  Decoder-reset
                    // PLI requests come back via drain_pli_requests() on the
                    // capture tick.
                    let Some(subscription) =
                        self.user_video_subscriptions.get_mut(&(role, user_id))
                    else {
                        return;
                    };
                    subscription.forwarded_frame_count =
                        subscription.forwarded_frame_count.saturating_add(1);
                    if subscription.forwarded_frame_count == 1 {
                        tracing::info!(
                            user_id,
                            ssrc,
                            codec = %codec,
                            keyframe,
                            frame_bytes = frame.len(),
                            rtp_timestamp,
                            stream_type = ?stream_type.as_deref(),
                            rid = ?rid.as_deref(),
                            max_frames_per_second = subscription.max_frames_per_second,
                            "clankvox_first_video_frame_forwarded"
                        );
                    }

                    self.video_decode_worker.submit_frame(
                        crate::video_decode_worker::VideoDecodeFrameJob {
                            role,
                            generation,
                            user_id,
                            ssrc,
                            frame,
                            jpeg_quality: subscription.jpeg_quality,
                            max_frames_per_second: subscription.max_frames_per_second,
                        },
                    );
                } else {
                    // ── Non-H264 (VP8): forward raw frame for TS-side ffmpeg decode ──
                    let Some(subscription) =
                        self.user_video_subscriptions.get_mut(&(role, user_id))
                    else {
                        return;
                    };

                    let now = time::Instant::now();
                    let min_gap = std::time::Duration::from_secs_f64(
                        1.0 / f64::from(subscription.max_frames_per_second.max(1)),
                    );
                    if let Some(last_frame_sent_at) = subscription.last_frame_sent_at
                        && now.duration_since(last_frame_sent_at) < min_gap
                        && !keyframe
                    {
                        return;
                    }
                    subscription.last_frame_sent_at = Some(now);

                    subscription.forwarded_frame_count =
                        subscription.forwarded_frame_count.saturating_add(1);
                    if subscription.forwarded_frame_count == 1 {
                        tracing::info!(
                            user_id,
                            ssrc,
                            codec = %codec,
                            keyframe,
                            frame_bytes = frame.len(),
                            rtp_timestamp,
                            stream_type = ?stream_type.as_deref(),
                            rid = ?rid.as_deref(),
                            max_frames_per_second = subscription.max_frames_per_second,
                            "clankvox_first_video_frame_forwarded"
                        );
                    }

                    let should_reassert_sink_wants =
                        should_reassert_sink_wants_for_waiting_keyframe(
                            subscription,
                            keyframe,
                            now,
                        );

                    let frame_base64 = base64::engine::general_purpose::STANDARD.encode(frame);
                    send_msg(OutMsg::UserVideoFrame {
                        role,
                        user_id: user_id.to_string(),
                        ssrc,
                        codec,
                        keyframe,
                        frame_base64,
                        rtp_timestamp,
                        stream_type: stream_type.clone(),
                        rid: rid.clone(),
                        dave_decrypted,
                    });
                    if should_reassert_sink_wants {
                        tracing::info!(
                            user_id,
                            ssrc,
                            forwarded_frame_count = subscription.forwarded_frame_count,
                            "clankvox_waiting_for_first_keyframe_reasserting_sink_wants"
                        );
                        self.refresh_video_sink_wants("waiting_for_first_keyframe");
                        if let Some(conn) = self.connection_for_role(role)
                            && let Err(error) = conn.send_rtcp_pli(ssrc)
                        {
                            tracing::warn!(
                                ssrc,
                                error = %error,
                                "clankvox_rtcp_pli_failed"
                            );
                        }
                    }
                }
            }
            VoiceEvent::DaveReady {
                role,
                generation: _,
                protocol_version,
            } => {
                if !self.mark_dave_ready(role, protocol_version) {
                    return;
                }
                tracing::info!(
                    role = role.as_str(),
                    protocol_version,
                    "DAVE E2EE session is ready"
                );
                self.emit_dave_state(role, DaveStateStatus::Ready, Some(protocol_version));
                // For stream watch: the initial keyframe burst from Discord
                // often arrives before the DAVE session is ready, so those
                // frames fail decrypt and are lost.  Immediately request a
                // fresh keyframe now that we can actually decrypt.
                self.request_video_keyframes(role);
            }
            VoiceEvent::Disconnected {
                role,
                generation: _,
                reason,
            } => match role {
                TransportRole::Voice => {
                    if self.guild_id.is_some() && self.channel_id.is_some() {
                        self.handle_disconnected(&reason);
                    } else {
                        tracing::info!(reason = %reason, "Ignoring primary disconnect after leave");
                    }
                }
                TransportRole::StreamWatch => {
                    tracing::warn!(reason = %reason, "Stream watch transport disconnected");
                    self.clear_stream_watch_connection();
                    self.emit_transport_state(
                        TransportRole::StreamWatch,
                        "disconnected",
                        Some(&reason),
                    );
                    self.refresh_video_sink_wants("stream_watch_disconnected");
                }
                TransportRole::StreamPublish => {
                    tracing::warn!(reason = %reason, "Stream publish transport disconnected");
                    self.stop_stream_publish_runtime("stream_publish_transport_disconnected");
                    self.clear_stream_publish_connection();
                    self.emit_transport_state(
                        TransportRole::StreamPublish,
                        "disconnected",
                        Some(&reason),
                    );
                }
            },
        }
    }

    pub(crate) fn on_capture_tick(&mut self, now: time::Instant) {
        // If the decode worker reset a decoder after sustained errors it
        // needs a fresh keyframe — send PLI from here because the transport
        // connection lives on the event loop, not the worker thread.
        for (role, generation, user_id, ssrc) in self.video_decode_worker.drain_pli_requests() {
            if generation != self.current_transport_generation(role) {
                continue;
            }
            tracing::info!(
                role = role.as_str(),
                user_id,
                ssrc,
                "clankvox_decoder_reset_requesting_pli"
            );
            self.refresh_video_sink_wants("decoder_reset_pli");
            if let Some(conn) = self.connection_for_role(role)
                && let Err(error) = conn.send_rtcp_pli(ssrc)
            {
                tracing::warn!(
                    ssrc,
                    error = %error,
                    "clankvox_decoder_reset_pli_failed"
                );
            }
        }

        let mut speaking_ended_users: Vec<u64> = Vec::new();
        for (&user_id, state) in &mut self.speaking_states {
            if !state.is_speaking {
                continue;
            }
            if let Some(last_at) = state.last_packet_at {
                let silent_ms = now.duration_since(last_at).as_millis() as u64;
                if silent_ms >= SPEAKING_TIMEOUT_MS {
                    state.is_speaking = false;
                    speaking_ended_users.push(user_id);
                }
            }
        }
        for user_id in speaking_ended_users {
            send_msg(OutMsg::SpeakingEnd {
                user_id: user_id.to_string(),
                capture_id: self
                    .user_capture_states
                    .get(&user_id)
                    .map(|capture| capture.capture_id.clone()),
            });
        }

        let mut ended_captures = Vec::new();
        for (&user_id, state) in &mut self.user_capture_states {
            if !state.stream_active {
                continue;
            }
            let Some(last_audio_at) = state.last_audio_at else {
                state.last_audio_at = Some(now);
                continue;
            };
            let silent_for_ms = now.duration_since(last_audio_at).as_millis() as u64;
            if silent_for_ms >= u64::from(state.silence_duration_ms) {
                ended_captures.push((user_id, state.capture_id.clone()));
            }
        }
        for (user_id, capture_id) in ended_captures {
            // Disarm the epoch before exposing its terminal event. An immediate
            // follow-up burst still emits SpeakingStart, but cannot inherit or
            // forward PCM under the completed capture id.
            self.user_capture_states.remove(&user_id);
            send_msg(OutMsg::UserAudioEnd {
                user_id: user_id.to_string(),
                capture_id,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;

    use crossbeam_channel as crossbeam;
    use parking_lot::Mutex;
    use tokio::sync::mpsc;
    use tokio::time;

    use crate::app_state::AppState;
    use crate::capture::{SpeakingState, UserCaptureState};
    use crate::music::{MusicEvent, MusicPcm};
    use crate::stream_publish::{StreamPublishEvent, StreamPublishFrame};
    use crate::video::UserVideoSubscription;
    use crate::voice_conn::{TransportRole, VoiceEvent};

    use super::{
        RtpSeqClass, classify_rtp_sequence, should_reassert_sink_wants_for_waiting_keyframe,
        update_speaking_state,
    };

    fn test_app_state() -> AppState {
        let (voice_event_tx, _voice_event_rx) = mpsc::channel::<VoiceEvent>(4);
        let (music_pcm_tx, music_pcm_rx) = crossbeam::bounded::<MusicPcm>(4);
        let (music_event_tx, _music_event_rx) = mpsc::channel::<MusicEvent>(4);
        let (stream_publish_frame_tx, stream_publish_frame_rx) =
            crossbeam::bounded::<StreamPublishFrame>(4);
        let (stream_publish_event_tx, stream_publish_event_rx) =
            crossbeam::bounded::<StreamPublishEvent>(4);
        AppState::new(
            Arc::new(Mutex::new(None)),
            voice_event_tx,
            Arc::new(Mutex::new(None)),
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
    fn update_speaking_state_only_triggers_on_first_packet_of_burst() {
        let mut speaking_states: HashMap<u64, SpeakingState> = HashMap::new();
        let first_packet_at = time::Instant::now();

        assert!(update_speaking_state(
            &mut speaking_states,
            42,
            first_packet_at
        ));
        assert!(!update_speaking_state(
            &mut speaking_states,
            42,
            first_packet_at + Duration::from_millis(20)
        ));

        let state = speaking_states.get(&42).expect("speaking state inserted");
        assert!(state.is_speaking);
        assert_eq!(
            state.last_packet_at,
            Some(first_packet_at + Duration::from_millis(20))
        );
    }

    #[test]
    fn audio_end_disarms_capture_before_an_immediate_follow_up_burst() {
        let mut state = test_app_state();
        let now = time::Instant::now();
        let mut capture = UserCaptureState::new("capture-old".into(), 24_000, 100);
        capture.touch_audio(now - Duration::from_millis(100));
        state.user_capture_states.insert(42, capture);
        state.speaking_states.insert(
            42,
            SpeakingState {
                last_packet_at: Some(now - Duration::from_millis(100)),
                is_speaking: true,
            },
        );

        state.on_capture_tick(now);
        assert!(!state.user_capture_states.contains_key(&42));
        assert!(!state.speaking_states.get(&42).unwrap().is_speaking);

        let role = TransportRole::Voice;
        state.ssrc_map.insert(7, 42);
        state.handle_voice_event(VoiceEvent::OpusReceived {
            role,
            generation: state.current_transport_generation(role),
            ssrc: 7,
            opus_frame: vec![0],
            rtp_sequence: 1,
        });

        assert!(state.speaking_states.get(&42).unwrap().is_speaking);
        assert!(!state.user_capture_states.contains_key(&42));
        assert!(!state.opus_decoders.contains_key(&7));
        assert!(!state.last_rtp_seq.contains_key(&7));
    }

    #[test]
    fn waiting_for_first_keyframe_reasserts_sink_wants_until_keyframe_arrives() {
        let mut subscription =
            UserVideoSubscription::new(2, 100, Some(921_600), Some("screen".into()), None);
        let started_at = time::Instant::now();

        assert!(should_reassert_sink_wants_for_waiting_keyframe(
            &mut subscription,
            false,
            started_at
        ));
        assert!(!should_reassert_sink_wants_for_waiting_keyframe(
            &mut subscription,
            false,
            started_at + Duration::from_millis(500)
        ));
        assert!(should_reassert_sink_wants_for_waiting_keyframe(
            &mut subscription,
            false,
            started_at + Duration::from_secs(2)
        ));
        assert!(!should_reassert_sink_wants_for_waiting_keyframe(
            &mut subscription,
            true,
            started_at + Duration::from_secs(3)
        ));
        assert_eq!(
            subscription.last_keyframe_forwarded_at,
            Some(started_at + Duration::from_secs(3))
        );
        assert_eq!(subscription.last_sink_wants_reasserted_at, None);
    }

    // --- RTP sequence classification tests ---

    #[test]
    fn rtp_seq_first_packet_returns_first() {
        assert_eq!(classify_rtp_sequence(None, 100), RtpSeqClass::First);
        assert_eq!(classify_rtp_sequence(None, 0), RtpSeqClass::First);
        assert_eq!(classify_rtp_sequence(None, u16::MAX), RtpSeqClass::First);
    }

    #[test]
    fn rtp_seq_sequential_packet() {
        assert_eq!(
            classify_rtp_sequence(Some(100), 101),
            RtpSeqClass::Sequential
        );
        assert_eq!(classify_rtp_sequence(Some(0), 1), RtpSeqClass::Sequential);
    }

    #[test]
    fn rtp_seq_sequential_wraps_u16() {
        assert_eq!(
            classify_rtp_sequence(Some(u16::MAX), 0),
            RtpSeqClass::Sequential
        );
        assert_eq!(
            classify_rtp_sequence(Some(65534), 65535),
            RtpSeqClass::Sequential
        );
    }

    #[test]
    fn rtp_seq_duplicate_detected() {
        assert_eq!(
            classify_rtp_sequence(Some(100), 100),
            RtpSeqClass::Duplicate
        );
        assert_eq!(classify_rtp_sequence(Some(0), 0), RtpSeqClass::Duplicate);
        assert_eq!(
            classify_rtp_sequence(Some(u16::MAX), u16::MAX),
            RtpSeqClass::Duplicate
        );
    }

    #[test]
    fn rtp_seq_forward_loss_small_gaps() {
        // Gap of 1 lost packet: prev=100, expected=101, got 102
        assert_eq!(
            classify_rtp_sequence(Some(100), 102),
            RtpSeqClass::ForwardLoss { lost_count: 1 }
        );
        // Gap of 3 lost packets
        assert_eq!(
            classify_rtp_sequence(Some(100), 104),
            RtpSeqClass::ForwardLoss { lost_count: 3 }
        );
        // Gap of exactly MAX_RECOVERABLE_GAP (5)
        assert_eq!(
            classify_rtp_sequence(Some(100), 106),
            RtpSeqClass::ForwardLoss { lost_count: 5 }
        );
    }

    #[test]
    fn rtp_seq_forward_loss_across_wraparound() {
        // prev=65534, expected=65535, got 0 → gap of 1 lost packet
        assert_eq!(
            classify_rtp_sequence(Some(65534), 0),
            RtpSeqClass::ForwardLoss { lost_count: 1 }
        );
        // prev=65533, expected=65534, got 0 → gap of 2
        assert_eq!(
            classify_rtp_sequence(Some(65533), 0),
            RtpSeqClass::ForwardLoss { lost_count: 2 }
        );
    }

    #[test]
    fn rtp_seq_forward_large_gap() {
        // Gap of 6 (> MAX_RECOVERABLE_GAP): prev=100, expected=101, got 107
        assert_eq!(
            classify_rtp_sequence(Some(100), 107),
            RtpSeqClass::ForwardLarge
        );
        assert_eq!(
            classify_rtp_sequence(Some(100), 200),
            RtpSeqClass::ForwardLarge
        );
        assert_eq!(
            classify_rtp_sequence(Some(100), 1000),
            RtpSeqClass::ForwardLarge
        );
    }

    #[test]
    fn rtp_seq_stale_reordered_packet() {
        assert_eq!(classify_rtp_sequence(Some(100), 99), RtpSeqClass::Stale);
        assert_eq!(classify_rtp_sequence(Some(100), 98), RtpSeqClass::Stale);
        assert_eq!(classify_rtp_sequence(Some(100), 50), RtpSeqClass::Stale);
    }

    #[test]
    fn rtp_seq_stale_across_wraparound() {
        // prev=5, expected=6, got 65535 → stale (late arrival from before wrap)
        assert_eq!(classify_rtp_sequence(Some(5), 65535), RtpSeqClass::Stale);
        assert_eq!(classify_rtp_sequence(Some(5), 65534), RtpSeqClass::Stale);
    }

    #[test]
    fn rtp_seq_large_forward_near_half_u16_is_forward() {
        // Distance ~32000 (positive i16) → ForwardLarge
        assert_eq!(
            classify_rtp_sequence(Some(0), 32000),
            RtpSeqClass::ForwardLarge
        );
    }

    #[test]
    fn rtp_seq_large_backward_near_half_u16_is_stale() {
        // prev=32000, expected=32001, got 0 → wrapping_sub maps to negative i16 → stale
        assert_eq!(classify_rtp_sequence(Some(32000), 0), RtpSeqClass::Stale);
    }
}
