//! Discord voice/stream transport: the connection handle plus its submodule
//! split — `protocol` (opcode payloads and negotiation), `handshake`
//! (Hello/Ready/Session Description + IP discovery), `ws_ops` (WS read/write
//! loops and opcode handling), `udp_rx` (UDP receive and DAVE decrypt
//! orchestration), `video_frames` (depacketizers), `tx` (outbound RTP/RTCP),
//! and `diagnostics` (DAVE-marker helpers).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::tungstenite::Message;
use tracing::{error, info, warn};

use crate::dave::DaveManager;
use crate::rtp::VideoCodecKind;
use crate::transport_crypto::TransportCrypto;
use crate::video::VideoStreamDescriptor;
use crate::video_state::{RemoteVideoTrackBinding, update_current_video_codec};

mod diagnostics;
mod handshake;
mod protocol;
mod tx;
mod udp_rx;
mod video_frames;
mod ws_ops;

use handshake::{
    HandshakeOverflow, ip_discovery, recv_hello, recv_ready, recv_session_description,
};
use protocol::{
    build_inactive_video_state_announcement, build_select_protocol_payload,
    ready_publish_video_stream_descriptors, ready_video_stream_descriptors,
};
use udp_rx::udp_recv_loop;
pub(crate) use video_frames::VideoFrameCandidate;
use ws_ops::{handle_binary_opcode, handle_text_opcode, ws_read_loop, ws_write_loop};

type WsStream = tokio_tungstenite::WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub(crate) fn parse_user_id(user_id: &str, context: &str) -> Option<u64> {
    match user_id.parse::<u64>() {
        Ok(user_id) => Some(user_id),
        Err(error) => {
            warn!(user_id, context, error = %error, "ignoring voice gateway payload with invalid user id");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Events emitted by the voice connection back to the main loop
// ---------------------------------------------------------------------------

pub enum VoiceEvent {
    Ready {
        role: TransportRole,
        ssrc: u32,
    },
    SsrcUpdate {
        role: TransportRole,
        ssrc: u32,
        user_id: u64,
    },
    VideoStateUpdate {
        role: TransportRole,
        user_id: u64,
        audio_ssrc: Option<u32>,
        video_ssrc: Option<u32>,
        codec: Option<String>,
        streams: Vec<VideoStreamDescriptor>,
    },
    ClientDisconnect {
        role: TransportRole,
        user_id: u64,
    },
    OpusReceived {
        role: TransportRole,
        ssrc: u32,
        opus_frame: Vec<u8>,
        rtp_sequence: u16,
    },
    VideoFrameReceived {
        role: TransportRole,
        user_id: u64,
        ssrc: u32,
        codec: String,
        keyframe: bool,
        frame: Vec<u8>,
        rtp_timestamp: u32,
        stream_type: Option<String>,
        rid: Option<String>,
        dave_decrypted: bool,
    },
    DaveReady {
        role: TransportRole,
    },
    Disconnected {
        role: TransportRole,
        reason: String,
    },
}

// ---------------------------------------------------------------------------
// Internal commands for the WS write task
// ---------------------------------------------------------------------------

enum WsCommand {
    SendJson(Value),
    SendBinary(Vec<u8>),
    /// Send a WebSocket Close frame and end the write loop.
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportRole {
    Voice,
    StreamWatch,
    StreamPublish,
}

impl TransportRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Voice => "voice",
            Self::StreamWatch => "stream_watch",
            Self::StreamPublish => "stream_publish",
        }
    }
}

pub struct VoiceConnectionParams<'a> {
    pub endpoint: &'a str,
    pub server_id: u64,
    pub user_id: u64,
    pub session_id: &'a str,
    pub token: &'a str,
    pub dave_channel_id: u64,
    pub role: TransportRole,
}

// ---------------------------------------------------------------------------
// VoiceConnection — the public handle
// ---------------------------------------------------------------------------

pub struct VoiceConnection {
    pub ssrc: u32,
    role: TransportRole,
    shutdown: Arc<AtomicBool>,
    udp_socket: Arc<UdpSocket>,
    crypto: Arc<TransportCrypto>,
    rtp_sequence: AtomicU32,
    timestamp: AtomicU32,
    video_payload_type: u8,
    video_ssrc: Option<u32>,
    video_streams: Vec<VideoStreamDescriptor>,
    video_sequence: AtomicU32,
    video_timestamp: AtomicU32,
    fir_sequence: AtomicU32,
    ws_cmd_tx: mpsc::Sender<WsCommand>,
    ws_read_task: JoinHandle<()>,
    ws_write_task: JoinHandle<()>,
    udp_recv_task: JoinHandle<()>,
}

impl VoiceConnection {
    /// Perform the full voice WS + UDP handshake, then spawn background tasks.
    #[allow(clippy::too_many_lines)]
    pub async fn connect(
        params: VoiceConnectionParams<'_>,
        event_tx: mpsc::Sender<VoiceEvent>,
        dave: Arc<Mutex<Option<DaveManager>>>,
    ) -> Result<Self> {
        let VoiceConnectionParams {
            endpoint,
            server_id,
            user_id,
            session_id,
            token,
            dave_channel_id,
            role,
        } = params;

        let ep = endpoint.trim_start_matches("wss://").trim_end_matches('/');
        let ws_url = format!("wss://{ep}/?v=9");
        info!(
            role = role.as_str(),
            endpoint_available = !ep.is_empty(),
            "Connecting voice WS"
        );

        let (ws, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .context("Voice WS connect failed")?;
        let (mut ws_write, mut ws_read) = ws.split();

        // ---- OP8 Hello ----
        let heartbeat_interval = recv_hello(&mut ws_read).await?;

        // ---- OP0 Identify (advertise DAVE v1 + v9 channel_id + video receive) ----
        let identify = json!({
            "op": 0,
            "d": {
                "server_id": server_id.to_string(),
                "user_id": user_id.to_string(),
                "session_id": session_id,
                "token": token,
                "channel_id": dave_channel_id.to_string(),
                "max_dave_protocol_version": 1,
                "video": true,
                "streams": [
                    { "type": "screen", "rid": "100", "quality": 100 }
                ]
            }
        });
        ws_write
            .send(Message::Text(identify.to_string()))
            .await
            .context("Send Identify")?;

        // Handshake overflow buffer: messages that arrive during the handshake
        // but aren't the target opcode (e.g. DAVE OP21/OP25 or video state) get
        // buffered here and replayed into the ws_read_loop once background tasks
        // are spawned.
        let mut handshake_overflow: HandshakeOverflow = Vec::new();

        // ---- OP2 Ready ----
        let ready = recv_ready(&mut ws_read, &mut handshake_overflow).await?;
        let ready_stream_ssrcs = ready
            .streams
            .iter()
            .filter_map(|stream| stream.ssrc.filter(|ssrc| *ssrc != 0))
            .collect::<Vec<_>>();
        info!(
            ssrc = ready.ssrc,
            video_ssrc = ready.video_ssrc,
            ready_stream_count = ready_stream_ssrcs.len(),
            ready_stream_ssrcs = ?ready_stream_ssrcs,
            udp_endpoint_available = !ready.ip.is_empty() && ready.port != 0,
            modes = ?ready.modes,
            experiments = ?ready.experiments,
            "clankvox_voice_ready"
        );

        // ---- UDP socket + IP discovery ----
        let udp = UdpSocket::bind("0.0.0.0:0").await.context("UDP bind")?;
        let voice_addr: SocketAddr = format!("{}:{}", ready.ip, ready.port)
            .parse()
            .context("Parse voice UDP addr")?;
        udp.connect(voice_addr).await.context("UDP connect")?;

        let (external_ip, external_port) = ip_discovery(&udp, ready.ssrc).await?;

        // ---- Select encryption mode ----
        let mode = if ready.modes.iter().any(|m| m == "aead_aes256_gcm_rtpsize") {
            "aead_aes256_gcm_rtpsize"
        } else if ready
            .modes
            .iter()
            .any(|m| m == "aead_xchacha20_poly1305_rtpsize")
        {
            warn!("AES256-GCM RTP-size unavailable; using XChaCha20-Poly1305 RTP-size fallback");
            "aead_xchacha20_poly1305_rtpsize"
        } else {
            bail!(
                "No supported encryption mode (need aead_aes256_gcm_rtpsize or aead_xchacha20_poly1305_rtpsize), got: {:?}",
                ready.modes
            );
        };

        // ---- OP1 Select Protocol ----
        let select = build_select_protocol_payload(
            &external_ip,
            external_port,
            mode,
            &ready.experiments,
            role,
        );
        ws_write
            .send(Message::Text(select.to_string()))
            .await
            .context("Send Select Protocol")?;

        // ---- OP4 Session Description ----
        let session_description =
            recv_session_description(&mut ws_read, &mut handshake_overflow).await?;
        let crypto = Arc::new(TransportCrypto::new(&session_description.secret_key, mode)?);
        info!(
            audio_codec = ?session_description.audio_codec,
            video_codec = ?session_description.video_codec,
            has_media_session_id = session_description.media_session_id.is_some(),
            "Voice session established, transport crypto ready"
        );
        if role == TransportRole::StreamPublish
            && session_description
                .video_codec
                .as_deref()
                .is_some_and(|codec| !codec.eq_ignore_ascii_case("h264"))
        {
            bail!(
                "stream publish negotiated unsupported video codec {:?}",
                session_description.video_codec
            );
        }

        let current_video_codec = Arc::new(Mutex::new(None::<String>));
        update_current_video_codec(
            &current_video_codec,
            session_description.video_codec.clone(),
        );

        if session_description.dave_protocol_version > 0 {
            match DaveManager::new(
                session_description.dave_protocol_version,
                user_id,
                dave_channel_id,
            ) {
                Ok((dm, pkg)) => {
                    *dave.lock() = Some(dm);
                    info!(
                        "DaveManager initialized with protocol version {}",
                        session_description.dave_protocol_version
                    );

                    let mut op26_payload = vec![26u8];
                    op26_payload.extend_from_slice(&pkg);
                    ws_write
                        .send(Message::Binary(op26_payload))
                        .await
                        .context("Send DAVE KeyPackage OP26")?;
                    info!("Sent DAVE OP26 KeyPackage to Discord ({} bytes)", pkg.len());
                }
                Err(e) => {
                    error!("Failed to initialize DaveManager: {e}");
                }
            }
        }

        // ---- Spawn background tasks ----
        let shutdown = Arc::new(AtomicBool::new(false));
        let (ws_cmd_tx, ws_cmd_rx) = mpsc::channel::<WsCommand>(128);
        let udp = Arc::new(udp);
        let ssrc_map: Arc<Mutex<HashMap<u32, u64>>> = Arc::new(Mutex::new(HashMap::new()));
        let video_ssrc_map: Arc<Mutex<HashMap<u32, RemoteVideoTrackBinding>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let ws_sequence = Arc::new(AtomicI32::new(-1));
        let disconnect_sent = Arc::new(AtomicBool::new(false));

        // WS read loop (handles Speaking updates, DAVE opcodes, video stream metadata, etc.)
        let ws_read_task = {
            let shutdown = shutdown.clone();
            let event_tx = event_tx.clone();
            let dave = dave.clone();
            let ws_cmd_tx = ws_cmd_tx.clone();
            let ssrc_map = ssrc_map.clone();
            let video_ssrc_map = video_ssrc_map.clone();
            let ws_sequence = ws_sequence.clone();
            let disconnect_sent = disconnect_sent.clone();
            let current_video_codec = current_video_codec.clone();
            if !handshake_overflow.is_empty() {
                info!(
                    "Replaying {} buffered handshake messages into read loop",
                    handshake_overflow.len()
                );
            }
            tokio::spawn(async move {
                for (i, msg) in handshake_overflow.into_iter().enumerate() {
                    match msg {
                        Message::Text(ref text) => {
                            if let Ok(v) = serde_json::from_str::<Value>(text) {
                                let op = v["op"].as_u64().unwrap_or(u64::MAX);
                                info!("Replay [{i}]: Text OP={op}");
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
                                    user_id,
                                    dave_channel_id,
                                    role,
                                    &ws_sequence,
                                )
                                .await;
                            } else {
                                info!("Replay [{i}]: Invalid Text");
                            }
                        }
                        Message::Binary(ref data) if data.len() >= 3 => {
                            let seq = u16::from_be_bytes([data[0], data[1]]);
                            let op = data[2];
                            info!(
                                "Replay [{}]: Binary OP={} seq={} len={}",
                                i,
                                op,
                                seq,
                                data.len()
                            );
                            handle_binary_opcode(
                                data,
                                &event_tx,
                                &ws_cmd_tx,
                                &dave,
                                role,
                                &ws_sequence,
                            )
                            .await;
                        }
                        Message::Binary(_) => {
                            info!("Replay [{i}]: Empty Binary");
                        }
                        _ => {
                            info!("Replay [{i}]: Other message type");
                        }
                    }
                }
                ws_read_loop(
                    ws_read,
                    event_tx,
                    ws_cmd_tx,
                    dave,
                    ssrc_map,
                    video_ssrc_map,
                    current_video_codec,
                    shutdown,
                    user_id,
                    dave_channel_id,
                    role,
                    ws_sequence,
                    disconnect_sent,
                )
                .await;
            })
        };

        // WS write loop (heartbeat + outgoing commands)
        let ws_write_task = {
            let shutdown = shutdown.clone();
            let ws_sequence = ws_sequence.clone();
            let event_tx = event_tx.clone();
            let disconnect_sent = disconnect_sent.clone();
            tokio::spawn(async move {
                ws_write_loop(
                    ws_write,
                    ws_cmd_rx,
                    shutdown,
                    heartbeat_interval,
                    role,
                    ws_sequence,
                    event_tx,
                    disconnect_sent,
                )
                .await;
            })
        };

        // UDP receive loop
        let udp_recv_task = {
            let shutdown = shutdown.clone();
            let event_tx = event_tx.clone();
            let crypto = crypto.clone();
            let dave = dave.clone();
            let udp = udp.clone();
            let ssrc_map = ssrc_map.clone();
            let video_ssrc_map = video_ssrc_map.clone();
            let disconnect_sent = disconnect_sent.clone();
            tokio::spawn(async move {
                udp_recv_loop(
                    udp,
                    crypto,
                    dave,
                    ssrc_map,
                    video_ssrc_map,
                    event_tx,
                    shutdown,
                    role,
                    disconnect_sent,
                )
                .await;
            })
        };

        if role == TransportRole::Voice {
            // Set speaking state so Discord knows we may transmit audio.
            let _ = ws_cmd_tx
                .send(WsCommand::SendJson(json!({
                    "op": 5,
                    "d": { "speaking": 1, "delay": 0, "ssrc": ready.ssrc }
                })))
                .await;
        }

        // Announce video capability (OP12) so Discord sends us other users' video states.
        // We declare our streams as inactive (we only receive, not send video).
        if let Some(video_state_announcement) =
            build_inactive_video_state_announcement(ready.ssrc, &ready)
        {
            let announced_video_ssrc = video_state_announcement["d"]["video_ssrc"].as_u64();
            let announced_stream_ssrcs = video_state_announcement["d"]["streams"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|stream| stream["ssrc"].as_u64())
                .collect::<Vec<_>>();
            info!(
                audio_ssrc = ready.ssrc,
                announced_video_ssrc,
                announced_stream_count = announced_stream_ssrcs.len(),
                announced_stream_ssrcs = ?announced_stream_ssrcs,
                "clankvox_sending_inactive_video_state_announcement"
            );
            let _ = ws_cmd_tx
                .send(WsCommand::SendJson(video_state_announcement))
                .await;
        } else {
            info!("No usable stream metadata in OP2 Ready, skipping OP12 video state announcement");
        }

        let _ = event_tx
            .send(VoiceEvent::Ready {
                role,
                ssrc: ready.ssrc,
            })
            .await;

        Ok(VoiceConnection {
            ssrc: ready.ssrc,
            role,
            shutdown,
            udp_socket: udp,
            crypto,
            rtp_sequence: AtomicU32::new(0),
            timestamp: AtomicU32::new(0),
            video_payload_type: VideoCodecKind::H264.payload_type(),
            video_ssrc: ready.video_ssrc.filter(|ssrc| *ssrc != 0).or_else(|| {
                ready_publish_video_stream_descriptors(&ready)
                    .first()
                    .map(|stream| stream.ssrc)
            }),
            video_streams: match role {
                TransportRole::StreamPublish => ready_publish_video_stream_descriptors(&ready),
                TransportRole::Voice | TransportRole::StreamWatch => {
                    ready_video_stream_descriptors(&ready)
                }
            },
            video_sequence: AtomicU32::new(0),
            video_timestamp: AtomicU32::new(0),
            fir_sequence: AtomicU32::new(0),
            ws_cmd_tx,
            ws_read_task,
            ws_write_task,
            udp_recv_task,
        })
    }

    pub fn shutdown(&self) {
        // Run teardown once — Drop calls shutdown after explicit shutdown.
        if self.shutdown.swap(true, Ordering::SeqCst) {
            return;
        }
        // Ask the write loop to send a WS Close frame so Discord sees a
        // graceful departure, then abort the tasks after a short grace
        // window.  UDP has no close handshake — stop it immediately.
        self.udp_recv_task.abort();
        let close_requested = self.ws_cmd_tx.try_send(WsCommand::Close).is_ok();
        let ws_read_abort = self.ws_read_task.abort_handle();
        let ws_write_abort = self.ws_write_task.abort_handle();
        if close_requested && let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                time::sleep(Duration::from_millis(250)).await;
                ws_read_abort.abort();
                ws_write_abort.abort();
            });
            return;
        }
        ws_read_abort.abort();
        ws_write_abort.abort();
    }
}

impl Drop for VoiceConnection {
    fn drop(&mut self) {
        self.shutdown();
    }
}

async fn send_disconnect_once(
    event_tx: &mpsc::Sender<VoiceEvent>,
    disconnect_sent: &Arc<AtomicBool>,
    role: TransportRole,
    reason: impl Into<String>,
) {
    if disconnect_sent
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let _ = event_tx
            .send(VoiceEvent::Disconnected {
                role,
                reason: reason.into(),
            })
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::parse_user_id;

    #[test]
    fn parse_user_id_rejects_non_numeric_values() {
        assert_eq!(parse_user_id("42", "test"), Some(42));
        assert_eq!(parse_user_id("bad", "test"), None);
    }
}
