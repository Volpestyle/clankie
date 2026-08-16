//! Outbound send paths on the voice connection: RTP audio frames, H264
//! access-unit packetization (single-NAL and FU-A), stream-publish state
//! announcements, media sink wants, and protected RTCP feedback (PLI/FIR).

use std::sync::atomic::Ordering;

use anyhow::{Context, Result, bail};
use serde_json::json;
use tracing::info;

use crate::h264::split_h264_annexb_nalus;
use crate::media_sink_wants::build_media_sink_wants_payload;
use crate::rtcp::build_protected_rtcp_packet;
use crate::rtp::{
    MAX_VIDEO_RTP_CHUNK_BYTES, RTP_HEADER_LEN, VIDEO_RTP_EXTENSION_HEADER,
    VIDEO_RTP_EXTENSION_PAYLOAD, build_rtp_header, build_video_rtp_header,
};
use crate::video_state::build_video_state_announcement;

use super::{TransportRole, VoiceConnection, WsCommand};

impl VoiceConnection {
    /// Build an RTP packet, transport-encrypt, and send via UDP.
    /// `opus_payload` should already be DAVE-encrypted if DAVE is active.
    pub async fn send_rtp_frame(&self, opus_payload: &[u8]) -> Result<()> {
        let seq = self.rtp_sequence.fetch_add(1, Ordering::SeqCst) as u16;
        let ts = self.timestamp.fetch_add(960, Ordering::SeqCst); // 20ms @ 48kHz
        let header = build_rtp_header(seq, ts, self.ssrc);

        let encrypted = self.crypto.encrypt(&header, opus_payload)?;

        let mut packet = Vec::with_capacity(RTP_HEADER_LEN + encrypted.len());
        packet.extend_from_slice(&header);
        packet.extend_from_slice(&encrypted);

        self.udp_socket.send(&packet).await.context("UDP send")?;
        Ok(())
    }

    pub async fn send_h264_frame(
        &self,
        access_unit: &[u8],
        timestamp_increment: u32,
    ) -> Result<()> {
        let Some(video_ssrc) = self.video_ssrc else {
            bail!("stream publish video_ssrc unavailable");
        };

        let nalus = split_h264_annexb_nalus(access_unit);
        if nalus.is_empty() {
            bail!("stream publish frame did not contain Annex-B NAL units");
        }

        let timestamp = self
            .video_timestamp
            .fetch_add(timestamp_increment.max(1), Ordering::SeqCst);

        for (nal_index, nal) in nalus.iter().enumerate() {
            if nal.is_empty() {
                continue;
            }
            let is_last_nal = nal_index + 1 == nalus.len();
            let max_single_nal_payload =
                MAX_VIDEO_RTP_CHUNK_BYTES.saturating_sub(VIDEO_RTP_EXTENSION_PAYLOAD.len());
            if nal.len() <= max_single_nal_payload {
                let seq = self.video_sequence.fetch_add(1, Ordering::SeqCst) as u16;
                let header = build_video_rtp_header(
                    self.video_payload_type,
                    seq,
                    timestamp,
                    video_ssrc,
                    is_last_nal,
                );
                let mut aad = Vec::with_capacity(RTP_HEADER_LEN + VIDEO_RTP_EXTENSION_HEADER.len());
                aad.extend_from_slice(&header);
                aad.extend_from_slice(&VIDEO_RTP_EXTENSION_HEADER);
                let mut payload = Vec::with_capacity(VIDEO_RTP_EXTENSION_PAYLOAD.len() + nal.len());
                payload.extend_from_slice(&VIDEO_RTP_EXTENSION_PAYLOAD);
                payload.extend_from_slice(nal);
                let encrypted = self.crypto.encrypt(&aad, &payload)?;
                let mut packet = Vec::with_capacity(
                    RTP_HEADER_LEN + VIDEO_RTP_EXTENSION_HEADER.len() + encrypted.len(),
                );
                packet.extend_from_slice(&header);
                packet.extend_from_slice(&VIDEO_RTP_EXTENSION_HEADER);
                packet.extend_from_slice(&encrypted);
                self.udp_socket
                    .send(&packet)
                    .await
                    .context("UDP send video packet")?;
                continue;
            }

            let nal_header = nal[0];
            let nal_type = nal_header & 0x1f;
            let fnri = nal_header & 0xe0;
            let fu_indicator = fnri | 28;
            let max_fu_payload = MAX_VIDEO_RTP_CHUNK_BYTES
                .saturating_sub(VIDEO_RTP_EXTENSION_PAYLOAD.len())
                .saturating_sub(2);
            for (chunk_index, chunk) in nal[1..].chunks(max_fu_payload).enumerate() {
                let is_first_chunk = chunk_index == 0;
                let chunk_start = chunk_index * max_fu_payload;
                let is_last_chunk = chunk_start + chunk.len() >= nal.len().saturating_sub(1);
                let marker = is_last_nal && is_last_chunk;
                let seq = self.video_sequence.fetch_add(1, Ordering::SeqCst) as u16;
                let header = build_video_rtp_header(
                    self.video_payload_type,
                    seq,
                    timestamp,
                    video_ssrc,
                    marker,
                );
                let fu_header = (if is_first_chunk { 0x80 } else { 0x00 })
                    | (if is_last_chunk { 0x40 } else { 0x00 })
                    | nal_type;
                let mut aad = Vec::with_capacity(RTP_HEADER_LEN + VIDEO_RTP_EXTENSION_HEADER.len());
                aad.extend_from_slice(&header);
                aad.extend_from_slice(&VIDEO_RTP_EXTENSION_HEADER);
                let mut payload =
                    Vec::with_capacity(VIDEO_RTP_EXTENSION_PAYLOAD.len() + 2 + chunk.len());
                payload.extend_from_slice(&VIDEO_RTP_EXTENSION_PAYLOAD);
                payload.extend_from_slice(&[fu_indicator, fu_header]);
                payload.extend_from_slice(chunk);
                let encrypted = self.crypto.encrypt(&aad, &payload)?;
                let mut packet = Vec::with_capacity(
                    RTP_HEADER_LEN + VIDEO_RTP_EXTENSION_HEADER.len() + encrypted.len(),
                );
                packet.extend_from_slice(&header);
                packet.extend_from_slice(&VIDEO_RTP_EXTENSION_HEADER);
                packet.extend_from_slice(&encrypted);
                self.udp_socket
                    .send(&packet)
                    .await
                    .context("UDP send video FU-A packet")?;
            }
        }

        Ok(())
    }

    pub fn set_stream_publish_speaking(&self, speaking: bool) -> Result<()> {
        if self.role != TransportRole::StreamPublish {
            return Ok(());
        }
        self.ws_cmd_tx
            .try_send(WsCommand::SendJson(json!({
                "op": 5,
                "d": {
                    "speaking": if speaking { 2 } else { 0 },
                    "delay": 0,
                    "ssrc": self.ssrc,
                }
            })))
            .map_err(|error| {
                anyhow::anyhow!("failed to enqueue stream publish speaking update: {error}")
            })
    }

    pub fn set_stream_publish_video_active(&self, active: bool) -> Result<()> {
        if self.role != TransportRole::StreamPublish {
            return Ok(());
        }
        let Some(payload) = build_video_state_announcement(self.ssrc, &self.video_streams, active)
        else {
            return Ok(());
        };
        self.ws_cmd_tx
            .try_send(WsCommand::SendJson(payload))
            .map_err(|error| {
                anyhow::anyhow!("failed to enqueue stream publish video state update: {error}")
            })
    }

    pub fn update_media_sink_wants(
        &self,
        wants: &[(u32, u8)],
        pixel_counts: &[(u32, f64)],
    ) -> Result<()> {
        let payload = build_media_sink_wants_payload(wants, pixel_counts);
        self.ws_cmd_tx
            .try_send(WsCommand::SendJson(payload))
            .map_err(|error| anyhow::anyhow!("failed to enqueue media sink wants: {error}"))
    }

    fn send_protected_rtcp_packet(
        &self,
        fmt_or_count: u8,
        packet_type: u8,
        body: &[u8],
        packet_label: &'static str,
    ) -> Result<usize> {
        let packet = build_protected_rtcp_packet(&self.crypto, fmt_or_count, packet_type, body)
            .with_context(|| format!("RTCP {packet_label} transport encrypt"))?;
        self.udp_socket
            .try_send(&packet)
            .with_context(|| format!("RTCP {packet_label} send"))?;
        Ok(packet.len())
    }

    /// Send protected RTCP feedback packets containing:
    ///   1. RR (Receiver Report)
    ///   2. PLI (Picture Loss Indication, RFC 4585)
    ///   3. FIR (Full Intra Request, RFC 5104)
    ///
    /// Under Discord's `rtpsize` modes, feedback rides the same transport
    /// protection as media. Each RTCP packet is protected independently so its
    /// header length still matches the on-wire packet bytes.
    pub fn send_rtcp_pli(&self, media_ssrc: u32) -> Result<()> {
        let fir_seq = self.fir_sequence.fetch_add(1, Ordering::Relaxed) as u8;

        let rr_body = self.ssrc.to_be_bytes();

        let mut pli_body = [0u8; 8];
        pli_body[0..4].copy_from_slice(&self.ssrc.to_be_bytes());
        pli_body[4..8].copy_from_slice(&media_ssrc.to_be_bytes());

        let mut fir_body = [0u8; 16];
        fir_body[0..4].copy_from_slice(&self.ssrc.to_be_bytes());
        fir_body[4..8].copy_from_slice(&0u32.to_be_bytes()); // media source = 0 for FIR
        fir_body[8..12].copy_from_slice(&media_ssrc.to_be_bytes());
        fir_body[12] = fir_seq;

        let rr_packet_len = self.send_protected_rtcp_packet(0, 201, &rr_body, "rr")?;
        let pli_packet_len = self.send_protected_rtcp_packet(1, 206, &pli_body, "pli")?;
        let fir_packet_len = self.send_protected_rtcp_packet(4, 206, &fir_body, "fir")?;
        info!(
            sender_ssrc = self.ssrc,
            media_ssrc,
            fir_seq,
            rr_packet_len,
            pli_packet_len,
            fir_packet_len,
            "clankvox_rtcp_pli_sent"
        );
        Ok(())
    }
}
