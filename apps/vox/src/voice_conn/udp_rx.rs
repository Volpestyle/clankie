//! UDP receive path: transport decrypt, depacketization, per-packet and
//! frame-level DAVE decrypt orchestration (with lazy fallback replay), and
//! inbound frame emission back to the event loop.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tracing::{debug, info, trace};

use crate::app_state::transport_stats;
use crate::dave::DaveManager;
use crate::h264::{collect_annexb_nal_types, h264_annexb_has_idr_slice};
use crate::rtp::{
    OPUS_PT, VideoCodecKind, parse_rtp_header, strip_rtp_extension_payload, strip_rtp_padding,
};
use crate::transport_crypto::TransportCrypto;
use crate::video_state::RemoteVideoTrackBinding;

use super::video_frames::{FallbackFrameBuffer, VideoDepacketizers, VideoFrameCandidate};
use super::{TransportRole, VoiceEvent, diagnostics, send_disconnect_once};

struct VideoFrameDecryptOutcome {
    frame: Option<Vec<u8>>,
    depacketizer_keyframe: bool,
    /// True only when DAVE successfully decrypted the frame (not passthrough).
    dave_decrypted: bool,
}

/// Decrypt one RTP video payload if it carries a DAVE trailer.
///
/// Used before H264/VP8 depacketization so Go Live's per-packet encryption
/// is stripped while the payload still has a trailer. Frame-level encryption
/// (voice/webcam) leaves FU-A start/mid packets unmarked; those stay on the
/// assemble-then-decrypt path.
///
/// Returns the plaintext and the user id that decrypted it so a late SSRC
/// map can be remapped the same way frame-level decrypt remaps.
fn try_decrypt_rtp_video_payload(
    dave: &Arc<Mutex<Option<DaveManager>>>,
    user_id: u64,
    payload: &[u8],
) -> Option<(Vec<u8>, u64)> {
    if payload.len() < 11 || !diagnostics::has_dave_marker(payload) {
        return None;
    }
    let mut guard = dave.lock();
    let dm = match &mut *guard {
        Some(dm) if dm.is_ready() && dm.protocol_version() != 0 => dm,
        _ => return None,
    };
    if let Ok(plain) = dm.decrypt_video(user_id, payload) {
        return Some((plain, user_id));
    }
    let candidates = dm.known_user_ids();
    for candidate_user_id in candidates {
        if candidate_user_id == user_id || candidate_user_id == dm.user_id() {
            continue;
        }
        if let Ok(plain) = dm.decrypt_video(candidate_user_id, payload) {
            return Some((plain, candidate_user_id));
        }
    }
    None
}

/// Accumulate whether every marked packet in the current access unit decrypted.
/// Unmarked packets (voice/webcam FU-A) leave the flag alone so those frames
/// still take the assemble-then-decrypt path.
fn note_ssrc_packet_dave(state: &mut HashMap<u32, bool>, ssrc: u32, marked: bool, decrypted: bool) {
    let all_ok = state.entry(ssrc).or_insert(true);
    if marked && !decrypted {
        *all_ok = false;
    }
}

fn take_ssrc_frame_dave_ok(state: &mut HashMap<u32, bool>, ssrc: u32) -> bool {
    state.remove(&ssrc).unwrap_or(false)
}

fn decrypt_video_frame_candidates(
    dave: &Arc<Mutex<Option<DaveManager>>>,
    video_ssrc_map: &Arc<Mutex<HashMap<u32, RemoteVideoTrackBinding>>>,
    binding_user_id: &mut u64,
    ssrc: u32,
    codec: VideoCodecKind,
    primary_candidate: Option<VideoFrameCandidate>,
    alternate_candidate: Option<VideoFrameCandidate>,
) -> VideoFrameDecryptOutcome {
    let mut ordered_candidates = Vec::new();
    if let Some(primary_candidate) = primary_candidate.as_ref() {
        ordered_candidates.push(primary_candidate);
    }
    if let Some(alternate_candidate) = alternate_candidate.as_ref() {
        let duplicate_of_primary = primary_candidate
            .as_ref()
            .is_some_and(|primary| primary.frame == alternate_candidate.frame);
        if !duplicate_of_primary {
            ordered_candidates.push(alternate_candidate);
        }
    }

    let fallback_candidate = primary_candidate.as_ref().or(alternate_candidate.as_ref());
    let Some(pass_through_candidate) = fallback_candidate else {
        return VideoFrameDecryptOutcome {
            frame: None,
            depacketizer_keyframe: false,
            dave_decrypted: false,
        };
    };

    let mut guard = dave.lock();
    match &mut *guard {
        Some(dm) => {
            dm.maybe_auto_execute_downgrade();
            let current_user_id = *binding_user_id;
            let can_decrypt = dm.is_ready()
                && (dm.protocol_version() != 0 || dm.can_passthrough(current_user_id));
            if !can_decrypt {
                return VideoFrameDecryptOutcome {
                    frame: Some(pass_through_candidate.frame.clone()),
                    depacketizer_keyframe: pass_through_candidate.depacketizer_keyframe,
                    dave_decrypted: false,
                };
            }

            if let Some((frame, depacketizer_keyframe)) =
                crate::dave::try_decrypt_video_candidate_for_user(
                    dm,
                    current_user_id,
                    &ordered_candidates,
                    ssrc,
                    codec,
                )
            {
                return VideoFrameDecryptOutcome {
                    frame: Some(frame),
                    depacketizer_keyframe,
                    dave_decrypted: true,
                };
            }

            for candidate_user_id in dm.known_user_ids() {
                if candidate_user_id == current_user_id || candidate_user_id == dm.user_id() {
                    continue;
                }
                if let Some((frame, depacketizer_keyframe)) =
                    crate::dave::try_decrypt_video_candidate_for_user(
                        dm,
                        candidate_user_id,
                        &ordered_candidates,
                        ssrc,
                        codec,
                    )
                {
                    if let Some(remapped_binding) = video_ssrc_map.lock().get_mut(&ssrc) {
                        remapped_binding.user_id = candidate_user_id;
                    }
                    debug!(
                        ssrc,
                        codec = codec.as_str(),
                        old_user_id = current_user_id,
                        new_user_id = candidate_user_id,
                        "UDP: remapped video ssrc after successful DAVE decrypt"
                    );
                    *binding_user_id = candidate_user_id;
                    return VideoFrameDecryptOutcome {
                        frame: Some(frame),
                        depacketizer_keyframe,
                        dave_decrypted: true,
                    };
                }
            }

            let known_users = dm.known_user_ids();
            let candidate_count = ordered_candidates.len();
            let frame_bytes = ordered_candidates
                .first()
                .map(|c| c.frame.len())
                .unwrap_or(0);
            // Check if the frame has DAVE magic marker (last 2 bytes = 0xFA 0xFA)
            let has_dave_marker = ordered_candidates
                .first()
                .is_some_and(|c| diagnostics::has_dave_marker(&c.frame));

            let trailer_supp_size = ordered_candidates
                .first()
                .and_then(|candidate| diagnostics::dave_trailer_supp_size(&candidate.frame));

            let internal_marker_count = ordered_candidates
                .first()
                .map_or(0, |c| diagnostics::count_internal_dave_markers(&c.frame));

            debug!(
                user_id = current_user_id,
                ssrc,
                codec = codec.as_str(),
                frame_bytes,
                has_dave_marker,
                trailer_supp_size,
                internal_marker_count,
                candidate_count,
                known_users = ?known_users,
                pv = dm.protocol_version(),
                "UDP drop: DAVE video decrypt failed for all candidate users"
            );
            dm.track_decrypt_failure();
            VideoFrameDecryptOutcome {
                frame: None,
                depacketizer_keyframe: false,
                dave_decrypted: false,
            }
        }
        None => VideoFrameDecryptOutcome {
            frame: Some(pass_through_candidate.frame.clone()),
            depacketizer_keyframe: pass_through_candidate.depacketizer_keyframe,
            dave_decrypted: false,
        },
    }
}

#[allow(clippy::too_many_lines)]
#[allow(clippy::too_many_arguments)]
pub(super) async fn udp_recv_loop(
    socket: Arc<UdpSocket>,
    crypto: Arc<TransportCrypto>,
    dave: Arc<Mutex<Option<DaveManager>>>,
    ssrc_map: Arc<Mutex<HashMap<u32, u64>>>,
    video_ssrc_map: Arc<Mutex<HashMap<u32, RemoteVideoTrackBinding>>>,
    event_tx: mpsc::Sender<VoiceEvent>,
    shutdown: Arc<AtomicBool>,
    role: TransportRole,
    disconnect_sent: Arc<AtomicBool>,
) {
    let mut buf = [0u8; 65_536];
    let mut video_depacketizers = VideoDepacketizers::default();
    let mut fallback_frame_buffers: HashMap<u32, FallbackFrameBuffer> = HashMap::new();
    let mut observed_transport_decrypt_failures = HashSet::<u8>::new();
    let mut video_frame_emit_count: u64 = 0;
    let mut video_keyframe_count: u64 = 0;
    let mut dave_video_decrypt_ok: u64 = 0;
    let mut dave_video_decrypt_fail: u64 = 0;
    let mut dave_video_passthrough: u64 = 0;
    let dave_video_diagnostics_enabled = tracing::enabled!(tracing::Level::DEBUG);

    let mut per_packet_dave_marker_total: u64 = 0;
    let mut per_packet_dave_marker_hits: u64 = 0;
    let mut per_packet_dave_probe_logged: bool = false;
    let mut per_ssrc_dave_ok: HashMap<u32, bool> = HashMap::new();
    let mut frame_diagnostic_ok_count: u64 = 0;
    let mut frame_diagnostic_fail_count: u64 = 0;
    const MAX_FRAME_DIAGNOSTICS: u64 = 10;

    loop {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        let n = match socket.recv(&mut buf).await {
            Ok(n) => n,
            Err(e) => {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
                send_disconnect_once(
                    &event_tx,
                    &disconnect_sent,
                    role,
                    format!("UDP recv error: {e}"),
                )
                .await;
                break;
            }
        };
        let packet = &buf[..n];

        let Some((sequence, timestamp, ssrc, header_size, marker)) = parse_rtp_header(packet)
        else {
            debug!("UDP drop: failed to parse RTP header");
            continue;
        };

        let payload_type = packet[1] & 0x7F;

        // RTCP packets (SR=200, RR=201, SDES=202, BYE=203, APP=204) share
        // the UDP socket via RTP/RTCP mux (RFC 5761).  Their payload-type
        // byte (masked to 7 bits) falls in 72-76.  We don't process inbound
        // RTCP — just skip before attempting RTP transport decryption, which
        // would fail because RTCP has a different AAD layout.
        if (72..=76).contains(&payload_type) {
            trace!(payload_type, ssrc, "UDP skip: inbound RTCP packet");
            continue;
        }

        if VideoCodecKind::is_rtx_payload_type(payload_type) {
            trace!(
                payload_type,
                ssrc, "UDP drop: RTX payload not yet supported"
            );
            continue;
        }

        let decrypted = match crypto.decrypt(packet, header_size) {
            Ok(p) => p,
            Err(e) => {
                if payload_type == OPUS_PT {
                    transport_stats()
                        .inbound_audio_transport_decrypt_fail
                        .fetch_add(1, Ordering::Relaxed);
                }
                if (payload_type == OPUS_PT
                    || VideoCodecKind::from_payload_type(payload_type).is_some())
                    && observed_transport_decrypt_failures.insert(payload_type)
                {
                    info!(
                        role = role.as_str(),
                        payload_type,
                        header_size,
                        error = %e,
                        "clankvox_transport_decrypt_failed"
                    );
                }
                debug!("UDP drop: Transport crypto decrypt failed: {e}");
                continue;
            }
        };

        // Strip RTP padding BEFORE extension stripping / depacketization.
        // Under `rtpsize` AEAD modes the padding is inside the encrypted
        // envelope.  If not stripped, padding bytes corrupt the H264 frame
        // body and cause DAVE AES-GCM tag verification failures (~60% of
        // video frames).
        let decrypted = strip_rtp_padding(packet, decrypted);

        let Some((primary_payload, fallback_payload)) =
            strip_rtp_extension_payload(packet, decrypted)
        else {
            debug!("UDP drop: RTP extension body exceeds decrypted payload");
            continue;
        };

        if payload_type == OPUS_PT {
            transport_stats()
                .inbound_audio_packets
                .fetch_add(1, Ordering::Relaxed);
            let user_id = ssrc_map.lock().get(&ssrc).copied();
            let fallback_payload = fallback_payload.as_deref();

            let (opus_frame_opt, remapped_user_id) = {
                let mut guard = dave.lock();
                match &mut *guard {
                    Some(dm) => {
                        dm.maybe_auto_execute_downgrade();

                        if !dm.is_ready() {
                            // Passthrough: move the payload, no per-packet clone.
                            (Some(primary_payload), None)
                        } else {
                            let candidate_user_ids = crate::dave::ordered_audio_candidate_user_ids(
                                user_id,
                                dm.user_id(),
                                &dm.known_user_ids(),
                            );
                            let mut recovered: Option<(Vec<u8>, u64)> = None;

                            for candidate_uid in candidate_user_ids {
                                if let Some((decrypted, _used_fallback_payload)) =
                                    crate::dave::try_decrypt_audio_payload_for_user(
                                        dm,
                                        candidate_uid,
                                        &primary_payload,
                                        fallback_payload,
                                        ssrc,
                                    )
                                {
                                    recovered = Some((decrypted, candidate_uid));
                                    break;
                                }
                            }

                            if let Some((decrypted, candidate_uid)) = recovered {
                                if user_id != Some(candidate_uid) {
                                    ssrc_map.lock().insert(ssrc, candidate_uid);
                                    info!(
                                        ssrc,
                                        old_user_id = user_id,
                                        new_user_id = candidate_uid,
                                        "UDP: remapped audio ssrc after successful DAVE decrypt"
                                    );
                                }
                                (Some(decrypted), Some(candidate_uid))
                            } else if let Some(uid) = user_id {
                                debug!("UDP drop: DAVE audio decrypt failed for {uid}");
                                transport_stats()
                                    .inbound_audio_dave_decrypt_fail
                                    .fetch_add(1, Ordering::Relaxed);
                                dm.track_decrypt_failure();
                                (None, None)
                            } else {
                                debug!(
                                    ssrc,
                                    candidate_user_count = dm.known_user_ids().len(),
                                    "UDP drop: DAVE audio decrypt could not resolve user for unmapped ssrc"
                                );
                                transport_stats()
                                    .inbound_audio_dave_decrypt_fail
                                    .fetch_add(1, Ordering::Relaxed);
                                dm.track_decrypt_failure();
                                (None, None)
                            }
                        }
                    }
                    None => (Some(primary_payload), None),
                }
            };

            let Some(opus_frame) = opus_frame_opt else {
                continue;
            };

            if let Some(remapped_user_id) = remapped_user_id.filter(|uid| Some(*uid) != user_id) {
                let _ = event_tx
                    .send(VoiceEvent::SsrcUpdate {
                        role,
                        ssrc,
                        user_id: remapped_user_id,
                    })
                    .await;
            }

            let _ = event_tx
                .send(VoiceEvent::OpusReceived {
                    role,
                    ssrc,
                    opus_frame,
                    rtp_sequence: sequence,
                })
                .await;
            continue;
        }

        let Some(codec) = VideoCodecKind::from_payload_type(payload_type) else {
            trace!(payload_type, ssrc, "UDP drop: unsupported RTP payload type");
            continue;
        };

        // Copy only the mapped user id per packet; the descriptor strings are
        // fetched once per completed frame at emit time.
        let Some(mut binding_user_id) = video_ssrc_map
            .lock()
            .get(&ssrc)
            .map(|binding| binding.user_id)
        else {
            trace!(
                payload_type,
                ssrc, "UDP drop: video packet from unknown ssrc"
            );
            continue;
        };

        // Detect the DAVE trailer on every packet. This used to be gated on
        // DEBUG tracing, which meant production never tried per-packet decrypt.
        // Go Live encrypts each RTP packet; the first byte of an encrypted
        // FU-A is not NAL type 28, so the depacketizer drops the packet and
        // no assembled frame ever reaches decrypt. Voice/webcam keep the
        // assemble-then-decrypt path when this attempt fails.
        let packet_has_dave_marker =
            primary_payload.len() >= 11 && diagnostics::has_dave_marker(&primary_payload);
        if dave_video_diagnostics_enabled && per_packet_dave_marker_total < 500 {
            per_packet_dave_marker_total += 1;
            if packet_has_dave_marker {
                per_packet_dave_marker_hits += 1;
            }
            if per_packet_dave_marker_total == 500 && !per_packet_dave_probe_logged {
                per_packet_dave_probe_logged = true;
                let pct = per_packet_dave_marker_hits * 100 / per_packet_dave_marker_total;
                debug!(
                    per_packet_dave_marker_hits,
                    per_packet_dave_marker_total, pct, "clankvox_per_packet_dave_marker_probe"
                );
            }
        }

        let decrypted_packet = if packet_has_dave_marker {
            try_decrypt_rtp_video_payload(&dave, binding_user_id, &primary_payload)
        } else {
            None
        };
        if let Some((_, recovered_user_id)) = decrypted_packet {
            if recovered_user_id != binding_user_id {
                if let Some(binding) = video_ssrc_map.lock().get_mut(&ssrc) {
                    binding.user_id = recovered_user_id;
                }
                debug!(
                    ssrc,
                    old_user_id = binding_user_id,
                    new_user_id = recovered_user_id,
                    "UDP: remapped video ssrc after per-packet DAVE decrypt"
                );
                binding_user_id = recovered_user_id;
            }
        }
        let decrypted_primary = decrypted_packet.as_ref().map(|(bytes, _)| bytes.as_slice());
        let depacketize_payload: &[u8] = decrypted_primary.unwrap_or(&primary_payload);

        let primary_candidate = video_depacketizers
            .push(
                ssrc,
                codec,
                sequence,
                timestamp,
                marker,
                depacketize_payload,
            )
            .map(|(frame, depacketizer_keyframe)| VideoFrameCandidate {
                frame,
                depacketizer_keyframe,
                used_fallback_payload: false,
            });
        // Buffer the alternate RTP-extension handling of this packet.  It is
        // only depacketized (replayed) when the primary path fails for a
        // completed frame — the common case never pays for it. Decrypt it
        // first when it carries a Go Live trailer, or fallback replay would
        // assemble ciphertext the same way the old path did.
        let alternate_raw = fallback_payload.as_deref().unwrap_or(&primary_payload);
        let alternate_has_dave_marker =
            alternate_raw.len() >= 11 && diagnostics::has_dave_marker(alternate_raw);
        let decrypted_alternate = if alternate_has_dave_marker {
            try_decrypt_rtp_video_payload(&dave, binding_user_id, alternate_raw)
        } else {
            None
        };
        let decrypted_alternate_bytes = decrypted_alternate
            .as_ref()
            .map(|(bytes, _)| bytes.as_slice());
        let alternate_payload = decrypted_alternate_bytes.unwrap_or(alternate_raw);
        note_ssrc_packet_dave(
            &mut per_ssrc_dave_ok,
            ssrc,
            packet_has_dave_marker || alternate_has_dave_marker,
            decrypted_packet.is_some() || decrypted_alternate.is_some(),
        );
        let fallback_buffer = fallback_frame_buffers.entry(ssrc).or_default();
        fallback_buffer.push(
            sequence,
            timestamp,
            marker,
            alternate_payload,
            fallback_payload.is_some() || decrypted_alternate.is_some(),
        );
        let fallback_replay_possible = marker && fallback_buffer.has_distinct_payload;

        // Skip DAVE decrypt + frame emit entirely when no frame completed —
        // most RTP packets are mid-frame FU-A fragments and calling
        // decrypt_video_frame_candidates on them just burns a mutex lock for
        // a guaranteed None result.
        if primary_candidate.is_none() && !fallback_replay_possible {
            if marker {
                fallback_buffer.clear();
                per_ssrc_dave_ok.remove(&ssrc);
            }
            continue;
        }

        let diag_frame_bytes = primary_candidate.as_ref().map(|c| c.frame.len());

        // If every marked packet in this access unit decrypted before
        // depacketize, the assembled frame is already plain codec data and
        // must NOT go through frame-level DAVE decrypt (it has no trailer).
        // Checking only the last packet used to emit mixed ciphertext when
        // an earlier FU-A fragment failed decrypt.
        let assembled_has_dave_marker = primary_candidate
            .as_ref()
            .is_some_and(|c| diagnostics::has_dave_marker(&c.frame));
        let frame_all_packets_decrypted = take_ssrc_frame_dave_ok(&mut per_ssrc_dave_ok, ssrc);
        let (mut video_frame_opt, mut depacketizer_keyframe, mut dave_decrypted) =
            match primary_candidate {
                Some(candidate) if frame_all_packets_decrypted && !assembled_has_dave_marker => {
                    (Some(candidate.frame), candidate.depacketizer_keyframe, true)
                }
                Some(candidate) => {
                    let VideoFrameDecryptOutcome {
                        frame,
                        depacketizer_keyframe,
                        dave_decrypted,
                    } = decrypt_video_frame_candidates(
                        &dave,
                        &video_ssrc_map,
                        &mut binding_user_id,
                        ssrc,
                        codec,
                        Some(candidate),
                        None,
                    );
                    (frame, depacketizer_keyframe, dave_decrypted)
                }
                None => (None, false, false),
            };

        // Lazy fallback: the primary path failed for a completed frame, so
        // now pay for depacketizing the alternate RTP-extension handling and
        // retry DAVE decrypt with that candidate.
        if video_frame_opt.is_none() {
            let alternate_candidate = fallback_frame_buffers
                .get(&ssrc)
                .and_then(|buffer| buffer.replay_candidate(ssrc, codec));
            if let Some(alternate_candidate) = alternate_candidate {
                let VideoFrameDecryptOutcome {
                    frame,
                    depacketizer_keyframe: alternate_keyframe,
                    dave_decrypted: alternate_dave_decrypted,
                } = decrypt_video_frame_candidates(
                    &dave,
                    &video_ssrc_map,
                    &mut binding_user_id,
                    ssrc,
                    codec,
                    None,
                    Some(alternate_candidate),
                );
                video_frame_opt = frame;
                depacketizer_keyframe = alternate_keyframe;
                dave_decrypted = alternate_dave_decrypted;
            }
        }

        // Frame boundary reached — the buffered packets are spent either way.
        if let Some(buffer) = fallback_frame_buffers.get_mut(&ssrc) {
            buffer.clear();
        }

        if video_frame_opt.is_some() {
            if dave_decrypted {
                dave_video_decrypt_ok += 1;
                transport_stats()
                    .inbound_video_dave_decrypt_ok
                    .fetch_add(1, Ordering::Relaxed);
                if dave_video_diagnostics_enabled
                    && frame_diagnostic_ok_count < MAX_FRAME_DIAGNOSTICS
                {
                    if let Some(frame_bytes) = diag_frame_bytes {
                        frame_diagnostic_ok_count += 1;
                        debug!(
                            ssrc,
                            codec = codec.as_str(),
                            frame_bytes,
                            "clankvox_dave_video_decrypt_ok_frame"
                        );
                    }
                }
            } else {
                dave_video_passthrough += 1;
                transport_stats()
                    .inbound_video_dave_passthrough
                    .fetch_add(1, Ordering::Relaxed);
            }
        } else {
            dave_video_decrypt_fail += 1;
            transport_stats()
                .inbound_video_dave_decrypt_fail
                .fetch_add(1, Ordering::Relaxed);
            if dave_video_diagnostics_enabled && frame_diagnostic_fail_count < MAX_FRAME_DIAGNOSTICS
            {
                if let Some(frame_bytes) = diag_frame_bytes {
                    frame_diagnostic_fail_count += 1;
                    debug!(
                        ssrc,
                        codec = codec.as_str(),
                        frame_bytes,
                        "clankvox_dave_video_decrypt_fail_frame"
                    );
                }
            }
        }
        let dave_total = dave_video_decrypt_ok + dave_video_decrypt_fail + dave_video_passthrough;
        if dave_total > 0 && (dave_total <= 5 || dave_total % 100 == 0) {
            let success_pct = if dave_total > 0 {
                dave_video_decrypt_ok * 100 / dave_total
            } else {
                0
            };
            info!(
                dave_video_decrypt_ok,
                dave_video_decrypt_fail,
                dave_video_passthrough,
                dave_total,
                success_pct,
                role = role.as_str(),
                "clankvox_dave_video_decrypt_stats"
            );
            // Also dump the davey-internal per-user decrypt stats
            if let Some(dm) = dave.lock().as_ref() {
                dm.log_decrypt_stats();
            }
        }

        let Some(frame) = video_frame_opt else {
            continue;
        };

        // Prepend cached SPS+PPS AFTER DAVE decrypt so the DAVE trailer's
        // unencrypted ranges reference correct offsets in the original frame.
        let frame = if codec == VideoCodecKind::H264 {
            video_depacketizers.prepend_cached_h264_params(ssrc, frame)
        } else {
            frame
        };

        let keyframe = match codec {
            VideoCodecKind::H264 => {
                // Only IDR (NAL type 5) counts as a keyframe for rate-
                // limiting.  SPS+PPS are prepended to every frame after DAVE
                // decrypt so ffmpeg can always decode, but that prepend must
                // NOT cause every frame to bypass the fps gate.
                depacketizer_keyframe || h264_annexb_has_idr_slice(&frame)
            }
            VideoCodecKind::Vp8 => {
                depacketizer_keyframe || frame.first().is_some_and(|byte| byte & 0x01 == 0)
            }
        };

        video_frame_emit_count += 1;
        if keyframe {
            video_keyframe_count += 1;
        }
        // Log NAL types for the first 5 H264 frames and periodically after that
        if codec == VideoCodecKind::H264
            && (video_frame_emit_count <= 5 || video_frame_emit_count % 100 == 0)
        {
            let nal_types = collect_annexb_nal_types(&frame);
            info!(
                ssrc,
                frame_bytes = frame.len(),
                keyframe,
                depacketizer_keyframe,
                video_frame_emit_count,
                video_keyframe_count,
                nal_types = ?nal_types,
                "clankvox_h264_frame_nal_diagnostic"
            );
        }

        // One descriptor fetch per completed frame (not per packet).
        let (stream_type, rid) = video_ssrc_map
            .lock()
            .get(&ssrc)
            .map_or((None, None), |binding| {
                (
                    binding.descriptor.stream_type.clone(),
                    binding.descriptor.rid.clone(),
                )
            });

        if event_tx
            .send(VoiceEvent::VideoFrameReceived {
                role,
                user_id: binding_user_id,
                ssrc,
                codec: codec.as_str().to_string(),
                keyframe,
                frame,
                rtp_timestamp: timestamp,
                stream_type,
                dave_decrypted,
                rid,
            })
            .await
            .is_ok()
        {
            transport_stats()
                .inbound_video_frames_emitted
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    info!("UDP recv loop exited");
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use parking_lot::Mutex;

    use crate::rtp::VideoCodecKind;
    use crate::video::VideoStreamDescriptor;
    use crate::video_state::RemoteVideoTrackBinding;

    use super::super::video_frames::VideoFrameCandidate;
    use super::{
        decrypt_video_frame_candidates, note_ssrc_packet_dave, take_ssrc_frame_dave_ok,
        try_decrypt_rtp_video_payload,
    };

    #[test]
    fn decrypt_video_frame_candidates_prefers_primary_candidate_without_dave() {
        let descriptor = VideoStreamDescriptor {
            ssrc: 4201,
            rtx_ssrc: None,
            rid: None,
            quality: None,
            stream_type: Some("screen".into()),
            active: Some(true),
            max_bitrate: None,
            max_framerate: None,
            max_resolution: None,
        };
        let dave = Arc::new(Mutex::new(None));
        let video_ssrc_map = Arc::new(Mutex::new(HashMap::from([(
            descriptor.ssrc,
            RemoteVideoTrackBinding {
                user_id: 42,
                descriptor: descriptor.clone(),
            },
        )])));
        let mut binding_user_id = 42u64;

        let outcome = decrypt_video_frame_candidates(
            &dave,
            &video_ssrc_map,
            &mut binding_user_id,
            4201,
            VideoCodecKind::H264,
            Some(VideoFrameCandidate {
                frame: vec![1, 2, 3],
                depacketizer_keyframe: true,
                used_fallback_payload: false,
            }),
            Some(VideoFrameCandidate {
                frame: vec![9, 9, 9],
                depacketizer_keyframe: false,
                used_fallback_payload: true,
            }),
        );

        assert_eq!(outcome.frame, Some(vec![1, 2, 3]));
        assert!(outcome.depacketizer_keyframe);
        assert_eq!(binding_user_id, 42);
    }

    #[test]
    fn decrypt_video_frame_candidates_uses_alternate_candidate_without_dave() {
        let descriptor = VideoStreamDescriptor {
            ssrc: 4301,
            rtx_ssrc: None,
            rid: None,
            quality: None,
            stream_type: Some("screen".into()),
            active: Some(true),
            max_bitrate: None,
            max_framerate: None,
            max_resolution: None,
        };
        let dave = Arc::new(Mutex::new(None));
        let video_ssrc_map = Arc::new(Mutex::new(HashMap::from([(
            descriptor.ssrc,
            RemoteVideoTrackBinding {
                user_id: 42,
                descriptor: descriptor.clone(),
            },
        )])));
        let mut binding_user_id = 42u64;

        let outcome = decrypt_video_frame_candidates(
            &dave,
            &video_ssrc_map,
            &mut binding_user_id,
            4301,
            VideoCodecKind::Vp8,
            None,
            Some(VideoFrameCandidate {
                frame: vec![7, 8, 9],
                depacketizer_keyframe: true,
                used_fallback_payload: true,
            }),
        );

        assert_eq!(outcome.frame, Some(vec![7, 8, 9]));
        assert!(outcome.depacketizer_keyframe);
    }

    #[test]
    fn try_decrypt_rtp_video_payload_is_a_no_op_without_a_dave_session() {
        let dave = Arc::new(Mutex::new(None));
        let mut marked = vec![0x61u8; 32];
        let n = marked.len();
        marked[n - 2] = 0xFA;
        marked[n - 1] = 0xFA;
        assert!(try_decrypt_rtp_video_payload(&dave, 42, &marked).is_none());
        assert!(try_decrypt_rtp_video_payload(&dave, 42, &[0x61, 0x62, 0x63]).is_none());
    }

    #[test]
    fn note_ssrc_packet_dave_requires_every_marked_packet_in_the_access_unit() {
        let mut state = HashMap::new();
        note_ssrc_packet_dave(&mut state, 7, true, true);
        note_ssrc_packet_dave(&mut state, 7, true, true);
        note_ssrc_packet_dave(&mut state, 7, true, false);
        assert!(!take_ssrc_frame_dave_ok(&mut state, 7));

        note_ssrc_packet_dave(&mut state, 8, true, true);
        note_ssrc_packet_dave(&mut state, 8, true, true);
        assert!(take_ssrc_frame_dave_ok(&mut state, 8));

        // Unmarked voice/webcam fragments must not veto the assemble-then-decrypt path.
        note_ssrc_packet_dave(&mut state, 9, false, false);
        note_ssrc_packet_dave(&mut state, 9, false, false);
        assert!(take_ssrc_frame_dave_ok(&mut state, 9));
    }
}
