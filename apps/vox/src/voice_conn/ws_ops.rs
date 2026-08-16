//! Voice WebSocket opcode handling: the read/write loops, text opcodes
//! (speaking, video state, session updates, DAVE transitions), binary DAVE
//! MLS opcodes, and heartbeat pacing.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};

use crate::dave::DaveManager;
use crate::video_state::{
    RemoteVideoStatePayload, RemoteVideoTrackBinding, apply_remote_video_state,
    update_current_video_codec,
};

use super::protocol::{
    EpochPayload, SessionUpdatePayload, SpeakingPayload, TransitionPayload, UserIdPayload,
    json_object_keys,
};
use super::{TransportRole, VoiceEvent, WsCommand, WsStream, parse_user_id, send_disconnect_once};

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub(super) async fn ws_read_loop(
    mut ws_read: futures_util::stream::SplitStream<WsStream>,
    event_tx: mpsc::Sender<VoiceEvent>,
    ws_cmd_tx: mpsc::Sender<WsCommand>,
    dave: Arc<Mutex<Option<DaveManager>>>,
    ssrc_map: Arc<Mutex<HashMap<u32, u64>>>,
    video_ssrc_map: Arc<Mutex<HashMap<u32, RemoteVideoTrackBinding>>>,
    current_video_codec: Arc<Mutex<Option<String>>>,
    shutdown: Arc<AtomicBool>,
    bot_user_id: u64,
    channel_id: u64,
    role: TransportRole,
    ws_sequence: Arc<AtomicI32>,
    disconnect_sent: Arc<AtomicBool>,
) {
    while let Some(msg) = ws_read.next().await {
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        match msg {
            Ok(Message::Text(text)) => {
                let v: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                // Track WebSocket sequence numbers for OP3 Heartbeat
                if let Some(s) = v["seq"].as_i64() {
                    ws_sequence.store(s as i32, Ordering::Relaxed);
                }

                let op = v["op"].as_u64().unwrap_or(u64::MAX);
                let d = &v["d"];
                handle_text_opcode(
                    op,
                    d,
                    &event_tx,
                    &ws_cmd_tx,
                    &dave,
                    &ssrc_map,
                    &video_ssrc_map,
                    &current_video_codec,
                    bot_user_id,
                    channel_id,
                    role,
                    &ws_sequence,
                )
                .await;
            }
            Ok(Message::Binary(data)) => {
                if data.is_empty() {
                    continue;
                }
                handle_binary_opcode(&data, &event_tx, &ws_cmd_tx, &dave, role, &ws_sequence).await;
            }
            Ok(Message::Close(frame)) => {
                let reason = match frame {
                    Some(cf) => format!(
                        "WebSocket closed by server: code={} reason={}",
                        cf.code, cf.reason
                    ),
                    None => "WebSocket closed by server (no close frame)".into(),
                };
                warn!("{reason}");
                send_disconnect_once(&event_tx, &disconnect_sent, role, reason).await;
                break;
            }
            Err(e) => {
                send_disconnect_once(
                    &event_tx,
                    &disconnect_sent,
                    role,
                    format!("WS read error: {e}"),
                )
                .await;
                break;
            }
            _ => {}
        }
    }
    info!("Voice WS read loop exited");
}

#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
pub(super) async fn handle_text_opcode(
    op: u64,
    d: &Value,
    event_tx: &mpsc::Sender<VoiceEvent>,
    ws_cmd_tx: &mpsc::Sender<WsCommand>,
    dave: &Arc<Mutex<Option<DaveManager>>>,
    ssrc_map: &Arc<Mutex<HashMap<u32, u64>>>,
    video_ssrc_map: &Arc<Mutex<HashMap<u32, RemoteVideoTrackBinding>>>,
    current_video_codec: &Arc<Mutex<Option<String>>>,
    bot_user_id: u64,
    channel_id: u64,
    role: TransportRole,
    _ws_sequence: &Arc<AtomicI32>,
) {
    match op {
        // Heartbeat ACK
        6 => {
            debug!("Voice heartbeat ACK");
        }
        // Speaking state update (OP5) — SSRC map only, speaking detection is audio-driven
        5 => {
            let payload: SpeakingPayload = match serde_json::from_value(d.clone()) {
                Ok(payload) => payload,
                Err(error) => {
                    warn!(error = %error, "ignoring malformed speaking payload");
                    return;
                }
            };
            let Some(uid) = parse_user_id(&payload.user_id, "speaking") else {
                return;
            };

            ssrc_map.lock().insert(payload.ssrc, uid);

            let _ = event_tx
                .send(VoiceEvent::SsrcUpdate {
                    role,
                    ssrc: payload.ssrc,
                    user_id: uid,
                })
                .await;
        }
        // Video stream metadata (Discord may send this as OP12 or OP18 depending on path)
        12 | 18 => {
            let has_streams = d.get("streams").is_some();
            let has_video_ssrc = d.get("video_ssrc").is_some();
            let has_audio_ssrc = d.get("audio_ssrc").is_some();
            let has_user_id = d.get("user_id").is_some();
            let payload_keys = json_object_keys(d);

            if has_streams || has_video_ssrc {
                let payload: RemoteVideoStatePayload = match serde_json::from_value(d.clone()) {
                    Ok(payload) => payload,
                    Err(error) => {
                        warn!(
                            error = %error,
                            op,
                            has_streams,
                            has_video_ssrc,
                            has_audio_ssrc,
                            has_user_id,
                            payload_keys = ?payload_keys,
                            "ignoring malformed video state payload"
                        );
                        return;
                    }
                };
                apply_remote_video_state(
                    payload,
                    event_tx,
                    video_ssrc_map,
                    current_video_codec,
                    role,
                )
                .await;
                return;
            }

            if op == 18 {
                info!(
                    has_streams,
                    has_video_ssrc,
                    has_audio_ssrc,
                    has_user_id,
                    payload_keys = ?payload_keys,
                    "clankvox_voice_ws_unclassified_op18"
                );
                return;
            }

            // Client disconnect (OP13 in current Discord docs, but some servers historically used OP12)
            let payload: UserIdPayload = match serde_json::from_value(d.clone()) {
                Ok(payload) => payload,
                Err(error) => {
                    warn!(
                        error = %error,
                        op,
                        has_streams,
                        has_video_ssrc,
                        has_audio_ssrc,
                        has_user_id,
                        payload_keys = ?payload_keys,
                        "ignoring malformed client disconnect payload"
                    );
                    return;
                }
            };
            let Some(uid) = parse_user_id(&payload.user_id, "client_disconnect") else {
                return;
            };
            ssrc_map.lock().retain(|_, v| *v != uid);
            video_ssrc_map
                .lock()
                .retain(|_, binding| binding.user_id != uid);
            let _ = event_tx
                .send(VoiceEvent::ClientDisconnect { role, user_id: uid })
                .await;
        }
        13 => {
            let payload: UserIdPayload = match serde_json::from_value(d.clone()) {
                Ok(payload) => payload,
                Err(error) => {
                    warn!(error = %error, "ignoring malformed client disconnect payload");
                    return;
                }
            };
            let Some(uid) = parse_user_id(&payload.user_id, "client_disconnect") else {
                return;
            };
            ssrc_map.lock().retain(|_, v| *v != uid);
            video_ssrc_map
                .lock()
                .retain(|_, binding| binding.user_id != uid);
            let _ = event_tx
                .send(VoiceEvent::ClientDisconnect { role, user_id: uid })
                .await;
        }
        // Session update / codec update
        14 => {
            let payload: SessionUpdatePayload = match serde_json::from_value(d.clone()) {
                Ok(payload) => payload,
                Err(error) => {
                    warn!(error = %error, "ignoring malformed session update payload");
                    return;
                }
            };
            if payload.video_codec.is_some() {
                update_current_video_codec(current_video_codec, payload.video_codec.clone());
            }
            debug!(
                audio_codec = ?payload.audio_codec,
                video_codec = ?payload.video_codec,
                has_media_session_id = payload.media_session_id.is_some(),
                keyframe_interval = ?payload.keyframe_interval,
                "voice session update"
            );
        }
        // OP21: DavePrepareTransition — a transition is upcoming, respond with OP23
        21 => {
            let payload: TransitionPayload = match serde_json::from_value(d.clone()) {
                Ok(payload) => payload,
                Err(error) => {
                    warn!(error = %error, "ignoring malformed DAVE OP21 payload");
                    return;
                }
            };
            info!(
                "DAVE OP21: prepare transition id={} pv={}",
                payload.transition_id, payload.protocol_version
            );
            let send_ready = {
                let mut guard = dave.lock();
                if let Some(ref mut dm) = *guard {
                    dm.prepare_transition(payload.transition_id, payload.protocol_version)
                } else {
                    false
                }
            };
            if send_ready {
                send_transition_ready(ws_cmd_tx, payload.transition_id, "prepare").await;
            }
        }
        // OP22: DaveExecuteTransition — finalize the pending transition
        22 => {
            let payload: TransitionPayload = match serde_json::from_value(d.clone()) {
                Ok(payload) => payload,
                Err(error) => {
                    warn!(error = %error, "ignoring malformed DAVE OP22 payload");
                    return;
                }
            };
            info!(
                "DAVE OP22: execute transition received, transition_id={}",
                payload.transition_id
            );
            let transitioned = {
                let mut guard = dave.lock();
                if let Some(ref mut dm) = *guard {
                    dm.execute_transition(payload.transition_id)
                } else {
                    false
                }
            };
            if transitioned {
                let ready = {
                    let guard = dave.lock();
                    guard.as_ref().is_some_and(DaveManager::is_ready)
                };
                if ready {
                    let _ = event_tx.send(VoiceEvent::DaveReady { role }).await;
                }
            }
        }
        // OP24: DavePrepareEpoch — a new DAVE epoch is upcoming
        24 => {
            let payload: EpochPayload = match serde_json::from_value(d.clone()) {
                Ok(payload) => payload,
                Err(error) => {
                    warn!(error = %error, "ignoring malformed DAVE OP24 payload");
                    return;
                }
            };
            info!(
                "DAVE OP24: prepare epoch pv={} epoch={}",
                payload.protocol_version, payload.epoch
            );

            if payload.protocol_version > 0 {
                let pkg_to_send = {
                    let mut guard = dave.lock();
                    if guard.is_none() {
                        match DaveManager::new(payload.protocol_version, bot_user_id, channel_id) {
                            Ok((dm, pkg)) => {
                                *guard = Some(dm);
                                Some(pkg)
                            }
                            Err(e) => {
                                error!("Failed to create DaveManager: {e}");
                                None
                            }
                        }
                    } else {
                        if let Some(ref mut dm) = *guard {
                            match dm.reinit() {
                                Ok(recovery) => Some(recovery.key_package),
                                Err(e) => {
                                    error!("Failed to reinit DaveManager for new epoch: {e}");
                                    None
                                }
                            }
                        } else {
                            None
                        }
                    }
                };

                if let Some(pkg) = pkg_to_send {
                    let mut op26_payload = vec![26u8];
                    op26_payload.extend_from_slice(&pkg);
                    let _ = ws_cmd_tx.send(WsCommand::SendBinary(op26_payload)).await;
                    info!(
                        "OP24: Sent DAVE OP26 KeyPackage to Discord ({} bytes)",
                        pkg.len()
                    );
                }
            }
        }
        _ => {
            debug!("Unknown voice WS opcode: {op}");
        }
    }
}

#[allow(clippy::too_many_lines)]
pub(super) async fn handle_binary_opcode(
    data: &[u8],
    event_tx: &mpsc::Sender<VoiceEvent>,
    ws_cmd_tx: &mpsc::Sender<WsCommand>,
    dave: &Arc<Mutex<Option<DaveManager>>>,
    role: TransportRole,
    ws_sequence: &Arc<AtomicI32>,
) {
    // Incoming binary frames from Discord Voice WebSocket have the format:
    // [ seq (2 bytes, BE) | opcode (1 byte) | payload (N bytes) ]
    if data.len() < 3 {
        warn!("Received truncated binary frame (len {})", data.len());
        return;
    }

    let seq = u16::from_be_bytes([data[0], data[1]]);
    ws_sequence.store(i32::from(seq), Ordering::Relaxed);
    let opcode = data[2];
    let payload = &data[3..];
    debug!("Handling binary opcode: {} (seq: {})", opcode, seq);

    match opcode {
        // OP25: MLS External Sender Package (server → client)
        25 => {
            info!(
                "DAVE binary OP25: external sender ({} bytes)",
                payload.len()
            );
            let set_sender_ok = {
                let mut guard = dave.lock();
                if let Some(ref mut dm) = *guard {
                    if let Err(e) = dm.set_external_sender(payload) {
                        error!("DAVE set_external_sender: {e}");
                        false
                    } else {
                        true
                    }
                } else {
                    false
                }
            };

            // We already sent OP26 when the session/epoch was initialized.
            // Sending a second OP26 here can create an extra transition that drifts
            // decrypt state and yields NoValidCryptorFound on inbound audio.
            if set_sender_ok {
                debug!("DAVE: external sender accepted; skipping duplicate OP26");
            }
        }
        // OP27: MLS Proposals (server → client)
        27 => {
            if payload.is_empty() {
                warn!("DAVE binary OP27: truncated payload");
                return;
            }
            let optype = payload[0];
            let proposals_payload = &payload[1..];
            info!(
                "DAVE binary OP27: proposals (optype: {}, {} bytes)",
                optype,
                proposals_payload.len()
            );

            let operation = if optype == 0 {
                davey::ProposalsOperationType::APPEND
            } else {
                davey::ProposalsOperationType::REVOKE
            };

            let response = {
                let mut guard = dave.lock();
                if let Some(ref mut dm) = *guard {
                    match dm.process_proposals(operation, proposals_payload, None) {
                        Ok(Some(cr)) => Some(cr.data),
                        Ok(None) => {
                            debug!("DAVE: no commit needed for proposals");
                            None
                        }
                        Err(e) => {
                            error!("DAVE process_proposals: {e}");
                            None
                        }
                    }
                } else {
                    None
                }
            };
            if let Some(commit_data) = response {
                let mut frame = Vec::with_capacity(1 + commit_data.len());
                frame.push(28); // OP28
                frame.extend_from_slice(&commit_data);
                let _ = ws_cmd_tx.send(WsCommand::SendBinary(frame)).await;
                debug!("DAVE: sent commit OP28 ({} bytes)", commit_data.len());
            }
        }
        // OP29: MLS Announce Commit Transition (server → client)
        29 => {
            if payload.len() < 2 {
                warn!("DAVE binary OP29: truncated payload");
                return;
            }
            let transition_id = u16::from_be_bytes([payload[0], payload[1]]);
            let commit_payload = &payload[2..];

            info!(
                "DAVE binary OP29: announce commit (transition_id: {}, {} bytes)",
                transition_id,
                commit_payload.len()
            );

            // Process commit under lock, collect any recovery action, then drop lock
            let (ready, success, recovery_action) =
                {
                    let mut guard = dave.lock();
                    if let Some(ref mut dm) = *guard {
                        match dm.process_commit(commit_payload) {
                            Ok(()) => {
                                dm.store_pending_transition(transition_id);
                                info!(
                                    role = role.as_str(),
                                    transition_id,
                                    known_users = ?dm.known_user_ids(),
                                    pv = dm.protocol_version(),
                                    ready = dm.is_ready(),
                                    "DAVE: commit processed, MLS group members"
                                );
                                (dm.is_ready(), true, None)
                            }
                            Err(e) => {
                                error!("DAVE process_commit: {e}");
                                let recovery = dm.reinit().map_err(|error| {
                                error!(error = %error, "DAVE reinit failed after commit error");
                                error
                            }).ok();
                                (false, false, recovery)
                            }
                        }
                    } else {
                        (false, false, None)
                    }
                };
            // Lock is dropped — safe to await

            if let Some(recovery) = recovery_action {
                send_recovery_action(ws_cmd_tx, recovery, "failed commit").await;
            }

            // Match discord.js behavior: for non-zero transitions, confirm readiness with OP23.
            if success && transition_id != 0 {
                send_transition_ready(ws_cmd_tx, transition_id, "commit").await;
            }

            if ready {
                let _ = event_tx.send(VoiceEvent::DaveReady { role }).await;
            }
        }
        // OP30: MLS Welcome (server → client)
        30 => {
            if payload.len() < 2 {
                warn!("DAVE binary OP30: truncated payload");
                return;
            }
            let transition_id = u16::from_be_bytes([payload[0], payload[1]]);
            let welcome_payload = &payload[2..];

            info!(
                "DAVE binary OP30: welcome (transition_id: {}, {} bytes)",
                transition_id,
                welcome_payload.len()
            );

            // Process welcome under lock, collect any recovery action, then drop lock
            let (ready, success, recovery_action) = {
                let mut guard = dave.lock();
                if let Some(ref mut dm) = *guard {
                    match dm.process_welcome(welcome_payload) {
                        Ok(()) => {
                            dm.store_pending_transition(transition_id);
                            info!(
                                role = role.as_str(),
                                transition_id,
                                known_users = ?dm.known_user_ids(),
                                pv = dm.protocol_version(),
                                ready = dm.is_ready(),
                                "DAVE: welcome processed, MLS group members"
                            );
                            (dm.is_ready(), true, None)
                        }
                        Err(e) => {
                            if is_already_in_group_error(&e) {
                                // AlreadyInGroup is only benign when we already processed
                                // the corresponding OP29 for this transition id.
                                if dm.has_pending_transition_id(transition_id) {
                                    debug!(
                                        "DAVE process_welcome: AlreadyInGroup for pending transition {} (expected as committer)",
                                        transition_id
                                    );
                                    dm.store_pending_transition(transition_id);
                                    (dm.is_ready(), true, None)
                                } else {
                                    warn!(
                                        "DAVE process_welcome: AlreadyInGroup for non-pending transition {}; ignoring stale welcome",
                                        transition_id
                                    );
                                    (dm.is_ready(), false, None)
                                }
                            } else {
                                error!("DAVE process_welcome failed: {e}");
                                let recovery = dm.reinit().map_err(|error| {
                                    error!(error = %error, "DAVE reinit failed after welcome error");
                                    error
                                }).ok();
                                (false, false, recovery)
                            }
                        }
                    }
                } else {
                    (false, false, None)
                }
            };
            // Lock is dropped — safe to await

            if let Some(recovery) = recovery_action {
                send_recovery_action(ws_cmd_tx, recovery, "failed welcome").await;
            }

            // Match discord.js behavior: for non-zero transitions, confirm readiness with OP23.
            if success && transition_id != 0 {
                send_transition_ready(ws_cmd_tx, transition_id, "welcome").await;
            }

            if ready {
                let _ = event_tx.send(VoiceEvent::DaveReady { role }).await;
            }
        }
        // OP31: MLS Invalid Commit Welcome
        31 => {
            warn!(
                "DAVE binary OP31: invalid commit welcome ({} bytes)",
                payload.len()
            );
        }
        _ => {
            debug!(
                "Unknown binary voice opcode: {} ({} bytes)",
                opcode,
                payload.len()
            );
        }
    }
}

async fn send_transition_ready(
    ws_cmd_tx: &mpsc::Sender<WsCommand>,
    transition_id: u16,
    reason: &str,
) {
    let _ = ws_cmd_tx
        .send(WsCommand::SendJson(json!({
            "op": 23,
            "d": { "transition_id": transition_id }
        })))
        .await;
    info!(
        "DAVE: sent OP23 transition ready for {} transition {}",
        reason, transition_id
    );
}

async fn send_recovery_action(
    ws_cmd_tx: &mpsc::Sender<WsCommand>,
    recovery: crate::dave::RecoveryAction,
    reason: &str,
) {
    let mut op31 = vec![31u8];
    op31.extend_from_slice(&recovery.transition_id.to_be_bytes());
    let _ = ws_cmd_tx.send(WsCommand::SendBinary(op31)).await;

    let mut op26 = vec![26u8];
    op26.extend_from_slice(&recovery.key_package);
    let _ = ws_cmd_tx.send(WsCommand::SendBinary(op26)).await;

    warn!("DAVE: recovery from {}, sent OP31 + OP26", reason);
}

fn is_already_in_group_error(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<davey::errors::ProcessWelcomeError>(),
        Some(davey::errors::ProcessWelcomeError::AlreadyInGroup)
    )
}

/// Clamp the server-provided heartbeat interval to a sane range.
/// `time::interval` panics on a zero duration, and `f64 as u64` maps NaN and
/// negative values to 0, so a malformed OP8 Hello would otherwise crash the
/// write loop.
fn clamp_heartbeat_interval_ms(raw_ms: f64) -> u64 {
    (raw_ms as u64).clamp(1_000, 120_000)
}

pub(super) async fn ws_write_loop(
    mut ws_write: futures_util::stream::SplitSink<WsStream, Message>,
    mut cmd_rx: mpsc::Receiver<WsCommand>,
    shutdown: Arc<AtomicBool>,
    heartbeat_interval_ms: f64,
    role: TransportRole,
    ws_sequence: Arc<AtomicI32>,
    event_tx: mpsc::Sender<VoiceEvent>,
    disconnect_sent: Arc<AtomicBool>,
) {
    let hb_dur = Duration::from_millis(clamp_heartbeat_interval_ms(heartbeat_interval_ms));
    let mut hb_interval = time::interval(hb_dur);
    // Consume first immediate tick so we don't send a heartbeat instantly.
    // Discord expects the first heartbeat after heartbeat_interval * jitter.
    hb_interval.tick().await;

    loop {
        tokio::select! {
            _ = hb_interval.tick() => {
                if shutdown.load(Ordering::Relaxed) { break; }
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;

                // Read the latest sequence from shared state (-1 means no sequence yet).
                let seq = ws_sequence.load(Ordering::Relaxed);

                let hb = if seq >= 0 {
                    json!({
                        "op": 3,
                        "d": {
                            "t": ts,
                            "seq_ack": seq
                        }
                    })
                } else {
                    json!({
                        "op": 3,
                        "d": {
                            "t": ts
                        }
                    })
                };
                if let Err(error) = ws_write.send(Message::Text(hb.to_string())).await {
                    send_disconnect_once(
                        &event_tx,
                        &disconnect_sent,
                        role,
                        format!("WS heartbeat send failed: {error}"),
                    )
                    .await;
                    break;
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(WsCommand::SendJson(v)) => {
                        if let Err(error) = ws_write.send(Message::Text(v.to_string())).await {
                            send_disconnect_once(
                                &event_tx,
                                &disconnect_sent,
                                role,
                                format!("WS command send failed: {error}"),
                            )
                            .await;
                            break;
                        }
                    }
                    Some(WsCommand::SendBinary(data)) => {
                        if let Err(error) = ws_write.send(Message::Binary(data)).await {
                            send_disconnect_once(
                                &event_tx,
                                &disconnect_sent,
                                role,
                                format!("WS binary send failed: {error}"),
                            )
                            .await;
                            break;
                        }
                    }
                    Some(WsCommand::Close) => {
                        // Graceful teardown: tell Discord we are leaving
                        // instead of vanishing mid-connection.
                        let _ = ws_write.send(Message::Close(None)).await;
                        break;
                    }
                    None => break,
                }
            }
        }
    }
    info!("Voice WS write loop exited");
}

#[cfg(test)]
mod tests {
    use super::{clamp_heartbeat_interval_ms, is_already_in_group_error};

    #[test]
    fn heartbeat_interval_clamp_rejects_pathological_values() {
        // time::interval panics on Duration::ZERO — NaN, zero, and negative
        // intervals from a malformed OP8 Hello must clamp to the floor.
        assert_eq!(clamp_heartbeat_interval_ms(f64::NAN), 1_000);
        assert_eq!(clamp_heartbeat_interval_ms(0.0), 1_000);
        assert_eq!(clamp_heartbeat_interval_ms(-500.0), 1_000);
        assert_eq!(clamp_heartbeat_interval_ms(13_750.0), 13_750);
        assert_eq!(clamp_heartbeat_interval_ms(f64::INFINITY), 120_000);
        assert_eq!(clamp_heartbeat_interval_ms(10_000_000.0), 120_000);
    }

    #[test]
    fn already_in_group_detection_matches_typed_variant_only() {
        let already = anyhow::Error::new(davey::errors::ProcessWelcomeError::AlreadyInGroup)
            .context("process_welcome");
        assert!(is_already_in_group_error(&already));

        let other = anyhow::Error::new(davey::errors::ProcessWelcomeError::NoExternalSender)
            .context("process_welcome");
        assert!(!is_already_in_group_error(&other));

        // A message that merely *mentions* the word must not match — the old
        // string matching treated any "already" in Debug output as benign.
        let unrelated = anyhow::anyhow!("user already speaking");
        assert!(!is_already_in_group_error(&unrelated));
    }
}
