//! Handshake helpers: synchronous WS reads during connect (Hello, Ready,
//! Session Description) and the UDP IP-discovery hole-punch.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures_util::StreamExt;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::net::UdpSocket;
use tokio::time;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info};

use super::protocol::{
    HelloPayload, ReadyPayload, SessionDescriptionPayload, VoiceOpcode, parse_voice_opcode,
};

/// Messages received during the handshake that weren't the target opcode.
/// These are buffered and replayed into the `ws_read_loop` so DAVE opcodes
/// (OP21 text, OP25/27/29/30 binary) that arrive between Ready and Session
/// Description aren't silently dropped.
pub(super) type HandshakeOverflow = Vec<Message>;

async fn recv_handshake_payload<P: DeserializeOwned>(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
    target_op: u64,
    target_label: &str,
    timeout_context: &'static str,
    invalid_payload_context: &'static str,
    mut overflow: Option<&mut HandshakeOverflow>,
) -> Result<P> {
    let deadline = time::Instant::now() + Duration::from_secs(10);
    loop {
        let msg = time::timeout_at(deadline, ws.next())
            .await
            .context(timeout_context)?
            .context("WS stream ended")?
            .context("WS error")?;
        match msg {
            Message::Text(text) => {
                let message: VoiceOpcode<Value> = parse_voice_opcode(&text)?;
                if message.op == target_op {
                    return serde_json::from_value(message.d).context(invalid_payload_context);
                }
                if let Some(buffer) = &mut overflow {
                    debug!(
                        "Handshake (waiting {target_label}): buffered text op={op}",
                        op = message.op
                    );
                    buffer.push(Message::Text(text));
                }
            }
            Message::Binary(data) => {
                if let Some(buffer) = &mut overflow {
                    debug!(
                        "Handshake (waiting {target_label}): buffered binary opcode={} ({} bytes)",
                        data.first().copied().unwrap_or(0),
                        data.len()
                    );
                    buffer.push(Message::Binary(data));
                }
            }
            _ => {}
        }
    }
}

pub(super) async fn recv_hello(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
) -> Result<f64> {
    let payload = recv_handshake_payload::<HelloPayload>(
        ws,
        8,
        "OP8",
        "Timeout waiting for OP8 Hello",
        "invalid hello payload",
        None,
    )
    .await?;
    Ok(payload.heartbeat_interval.unwrap_or(13_750.0))
}

pub(super) async fn recv_ready(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
    overflow: &mut HandshakeOverflow,
) -> Result<ReadyPayload> {
    recv_handshake_payload(
        ws,
        2,
        "OP2",
        "Timeout waiting for OP2 Ready",
        "invalid ready payload",
        Some(overflow),
    )
    .await
}

pub(super) async fn recv_session_description(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
    overflow: &mut HandshakeOverflow,
) -> Result<SessionDescriptionPayload> {
    recv_handshake_payload(
        ws,
        4,
        "OP4",
        "Timeout waiting for OP4 Session Description",
        "invalid session description payload",
        Some(overflow),
    )
    .await
}

// ---------------------------------------------------------------------------
// UDP IP discovery (Discord voice hole-punch)
// ---------------------------------------------------------------------------

pub(super) async fn ip_discovery(socket: &UdpSocket, ssrc: u32) -> Result<(String, u16)> {
    let mut buf = [0u8; 74];
    // Type=0x0001, Length=70
    buf[0..2].copy_from_slice(&0x0001u16.to_be_bytes());
    buf[2..4].copy_from_slice(&70u16.to_be_bytes());
    buf[4..8].copy_from_slice(&ssrc.to_be_bytes());

    socket.send(&buf).await.context("IP discovery send")?;

    let mut resp = [0u8; 74];
    let timeout = time::timeout(Duration::from_secs(5), socket.recv(&mut resp)).await;
    let n = timeout
        .context("IP discovery timeout")?
        .context("IP discovery recv")?;
    if n < 74 {
        bail!("IP discovery response too short: {n} bytes");
    }

    // Response: [type(2) | length(2) | ssrc(4) | address(64) | port(2)]
    let ip_bytes = &resp[8..72];
    let ip = std::str::from_utf8(ip_bytes)
        .context("IP discovery: invalid UTF-8")?
        .trim_end_matches('\0')
        .to_string();
    let port = u16::from_be_bytes([resp[72], resp[73]]);

    info!("IP discovery: external {ip}:{port}");
    Ok((ip, port))
}

#[cfg(test)]
mod tests {
    use futures_util::stream;
    use tokio_tungstenite::tungstenite::Message;

    use super::{recv_ready, recv_session_description};

    #[tokio::test]
    async fn recv_ready_buffers_non_target_text_frames() {
        let mut ws = stream::iter(vec![
            Ok(Message::Text(r#"{"op":6,"d":{}}"#.into())),
            Ok(Message::Text(
                r#"{"op":2,"d":{"ssrc":9689,"ip":"104.29.137.71","port":19296,"modes":["aead_aes256_gcm_rtpsize"]}}"#
                    .into(),
            )),
        ]);
        let mut overflow = Vec::new();

        let ready = recv_ready(&mut ws, &mut overflow)
            .await
            .expect("ready payload");

        assert_eq!(ready.ssrc, 9689);
        assert_eq!(ready.ip, "104.29.137.71");
        assert_eq!(ready.port, 19296);
        assert_eq!(ready.modes, vec!["aead_aes256_gcm_rtpsize"]);
        assert_eq!(overflow.len(), 1);
    }

    #[tokio::test]
    async fn recv_session_description_buffers_non_target_text_frames() {
        let mut ws = stream::iter(vec![
            Ok(Message::Text(r#"{"op":18,"d":{"streams":[]}}"#.into())),
            Ok(Message::Text(
                r#"{"op":4,"d":{"secret_key":[1,2,3,4],"dave_protocol_version":1}}"#.into(),
            )),
        ]);
        let mut overflow = Vec::new();

        let session_description = recv_session_description(&mut ws, &mut overflow)
            .await
            .expect("session description payload");

        assert_eq!(*session_description.secret_key, vec![1, 2, 3, 4]);
        assert_eq!(session_description.dave_protocol_version, 1);
        assert_eq!(overflow.len(), 1);
    }
}
