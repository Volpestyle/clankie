use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::rtp::{OPUS_PT, VideoCodecKind};
use crate::video::{VideoResolution, VideoStreamDescriptor};
use crate::video_state::{
    RemoteVideoStreamPayload, build_video_state_announcement, convert_video_stream_descriptor,
};

use super::TransportRole;

#[derive(Debug, Deserialize)]
pub(super) struct VoiceOpcode<T> {
    pub(super) op: u64,
    pub(super) d: T,
}

#[derive(Debug, Deserialize)]
pub(super) struct HelloPayload {
    pub(super) heartbeat_interval: Option<f64>,
}

#[derive(Debug, Deserialize, Clone)]
pub(super) struct ReadyPayload {
    pub(super) ssrc: u32,
    pub(super) ip: String,
    pub(super) port: u16,
    pub(super) modes: Vec<String>,
    #[serde(default)]
    pub(super) experiments: Vec<String>,
    #[serde(default)]
    pub(super) video_ssrc: Option<u32>,
    #[serde(default)]
    pub(super) streams: Vec<RemoteVideoStreamPayload>,
}

#[derive(Deserialize, Clone)]
pub(super) struct SessionDescriptionPayload {
    /// Transport secret key. Wrapped in [`Zeroizing`] so the bytes are wiped
    /// from memory when the payload is dropped, and redacted from the manual
    /// [`Debug`] impl below.
    #[serde(deserialize_with = "deserialize_secret_key")]
    pub(super) secret_key: Zeroizing<Vec<u8>>,
    #[serde(default)]
    pub(super) dave_protocol_version: u16,
    #[serde(default)]
    pub(super) video_codec: Option<String>,
    #[serde(default)]
    pub(super) audio_codec: Option<String>,
    #[serde(default)]
    pub(super) media_session_id: Option<String>,
}

fn deserialize_secret_key<'de, D>(deserializer: D) -> Result<Zeroizing<Vec<u8>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Vec::<u8>::deserialize(deserializer).map(Zeroizing::new)
}

impl std::fmt::Debug for SessionDescriptionPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionDescriptionPayload")
            .field(
                "secret_key",
                &format_args!("[redacted; {} bytes]", self.secret_key.len()),
            )
            .field("dave_protocol_version", &self.dave_protocol_version)
            .field("video_codec", &self.video_codec)
            .field("audio_codec", &self.audio_codec)
            .field("media_session_id", &self.media_session_id)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct SpeakingPayload {
    pub(super) ssrc: u32,
    pub(super) user_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct UserIdPayload {
    pub(super) user_id: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct TransitionPayload {
    pub(super) transition_id: u16,
    #[serde(default)]
    pub(super) protocol_version: u16,
}

#[derive(Debug, Deserialize)]
pub(super) struct EpochPayload {
    pub(super) protocol_version: u16,
    pub(super) epoch: u64,
}

#[derive(Debug, Deserialize, Clone)]
pub(super) struct SessionUpdatePayload {
    #[serde(default)]
    pub(super) video_codec: Option<String>,
    #[serde(default)]
    pub(super) audio_codec: Option<String>,
    #[serde(default)]
    pub(super) media_session_id: Option<String>,
    #[serde(default)]
    pub(super) keyframe_interval: Option<u32>,
}

pub(super) fn parse_voice_opcode<T>(text: &str) -> Result<VoiceOpcode<T>>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str(text).context("invalid voice gateway payload")
}

pub(super) fn ready_video_stream_descriptors(ready: &ReadyPayload) -> Vec<VideoStreamDescriptor> {
    ready
        .streams
        .clone()
        .into_iter()
        .filter_map(convert_video_stream_descriptor)
        .collect()
}

fn default_publish_video_stream_descriptor(video_ssrc: u32) -> VideoStreamDescriptor {
    VideoStreamDescriptor {
        ssrc: video_ssrc,
        rtx_ssrc: None,
        rid: Some("100".to_string()),
        quality: Some(100),
        stream_type: Some("screen".to_string()),
        active: Some(true),
        max_bitrate: Some(2_500_000),
        max_framerate: Some(30),
        max_resolution: Some(VideoResolution {
            width: Some(1280),
            height: Some(720),
            resolution_type: Some("fixed".to_string()),
        }),
    }
}

pub(super) fn ready_publish_video_stream_descriptors(
    ready: &ReadyPayload,
) -> Vec<VideoStreamDescriptor> {
    let streams = ready_video_stream_descriptors(ready);
    if !streams.is_empty() {
        return streams;
    }
    ready
        .video_ssrc
        .filter(|ssrc| *ssrc != 0)
        .map(default_publish_video_stream_descriptor)
        .into_iter()
        .collect()
}

pub(super) fn build_inactive_video_state_announcement(
    audio_ssrc: u32,
    ready: &ReadyPayload,
) -> Option<Value> {
    let streams = ready_video_stream_descriptors(ready);
    build_video_state_announcement(audio_ssrc, &streams, false)
}

pub(super) fn json_object_keys(value: &Value) -> Vec<String> {
    value
        .as_object()
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default()
}

pub(super) fn build_select_protocol_payload(
    external_ip: &str,
    external_port: u16,
    mode: &str,
    experiments: &[String],
    role: TransportRole,
) -> Value {
    let video_codecs = match role {
        TransportRole::StreamPublish => vec![json!({
            "name": VideoCodecKind::H264.as_str(),
            "type": "video",
            "priority": 900,
            "payload_type": VideoCodecKind::H264.payload_type(),
            "rtx_payload_type": VideoCodecKind::H264.rtx_payload_type(),
            "encode": true,
            "decode": false,
        })],
        TransportRole::Voice | TransportRole::StreamWatch => {
            [VideoCodecKind::H264, VideoCodecKind::Vp8]
                .into_iter()
                .enumerate()
                .map(|(idx, codec)| {
                    json!({
                        "name": codec.as_str(),
                        "type": "video",
                        "priority": 900u32.saturating_sub(idx as u32 * 10),
                        "payload_type": codec.payload_type(),
                        "rtx_payload_type": codec.rtx_payload_type(),
                        "encode": false,
                        "decode": true,
                    })
                })
                .collect::<Vec<_>>()
        }
    };

    let mut codecs = vec![json!({
        "name": "opus",
        "type": "audio",
        "priority": 1000,
        "payload_type": OPUS_PT,
    })];
    codecs.extend(video_codecs);

    json!({
        "op": 1,
        "d": {
            "protocol": "udp",
            "data": {
                "address": external_ip,
                "port": external_port,
                "mode": mode
            },
            "codecs": codecs,
            "experiments": experiments,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{HelloPayload, SessionDescriptionPayload, VoiceOpcode, parse_voice_opcode};

    #[test]
    fn parse_voice_opcode_rejects_invalid_secret_key_bytes() {
        let text = r#"{"op":4,"d":{"secret_key":[1,999],"dave_protocol_version":1}}"#;

        let parsed = parse_voice_opcode::<SessionDescriptionPayload>(text);
        assert!(parsed.is_err());
    }

    #[test]
    fn parse_voice_opcode_reads_hello_payload() {
        let text = r#"{"op":8,"d":{"heartbeat_interval":2500.0}}"#;

        let parsed: VoiceOpcode<HelloPayload> = parse_voice_opcode(text).expect("hello payload");
        assert_eq!(parsed.op, 8);
        assert_eq!(parsed.d.heartbeat_interval, Some(2500.0));
    }
}
