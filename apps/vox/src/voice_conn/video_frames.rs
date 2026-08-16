use std::collections::HashMap;

use tracing::debug;

use crate::h264::H264Depacketizer;
use crate::rtp::VideoCodecKind;
use crate::vp8::Vp8Depacketizer;

#[derive(Clone)]
pub(crate) struct VideoFrameCandidate {
    pub(crate) frame: Vec<u8>,
    pub(crate) depacketizer_keyframe: bool,
    pub(crate) used_fallback_payload: bool,
}

#[derive(Default)]
pub(super) struct VideoDepacketizers {
    by_ssrc: HashMap<u32, VideoDepacketizerState>,
}

impl VideoDepacketizers {
    pub(super) fn push(
        &mut self,
        ssrc: u32,
        codec: VideoCodecKind,
        sequence: u16,
        timestamp: u32,
        marker: bool,
        payload: &[u8],
    ) -> Option<(Vec<u8>, bool)> {
        let state = self
            .by_ssrc
            .entry(ssrc)
            .or_insert_with(|| VideoDepacketizerState::new(codec));
        if state.codec != codec {
            *state = VideoDepacketizerState::new(codec);
        }
        state.push(ssrc, sequence, timestamp, marker, payload)
    }

    /// Prepend cached SPS+PPS from the depacketizer to a frame.
    /// Called AFTER DAVE decrypt so the DAVE trailer's unencrypted ranges
    /// reference the correct byte offsets in the original frame.
    pub(super) fn prepend_cached_h264_params(&self, ssrc: u32, frame: Vec<u8>) -> Vec<u8> {
        if let Some(state) = self.by_ssrc.get(&ssrc) {
            state.h264.prepend_cached_parameter_sets(frame)
        } else {
            frame
        }
    }
}

struct VideoDepacketizerState {
    codec: VideoCodecKind,
    last_sequence: Option<u16>,
    h264: H264Depacketizer,
    vp8: Vp8Depacketizer,
}

impl VideoDepacketizerState {
    fn new(codec: VideoCodecKind) -> Self {
        Self {
            codec,
            last_sequence: None,
            h264: H264Depacketizer::default(),
            vp8: Vp8Depacketizer::default(),
        }
    }

    fn push(
        &mut self,
        ssrc: u32,
        sequence: u16,
        timestamp: u32,
        marker: bool,
        payload: &[u8],
    ) -> Option<(Vec<u8>, bool)> {
        if let Some(previous_sequence) = self.last_sequence {
            let expected_sequence = previous_sequence.wrapping_add(1);
            if expected_sequence != sequence {
                debug!(
                    ssrc,
                    codec = self.codec.as_str(),
                    expected_sequence,
                    sequence,
                    timestamp,
                    "UDP video sequence gap/reorder detected; dropping partial frame"
                );
                self.clear_partial_frame();
            }
        }
        self.last_sequence = Some(sequence);

        match self.codec {
            VideoCodecKind::H264 => self.h264.push(timestamp, marker, payload),
            VideoCodecKind::Vp8 => self.vp8.push(timestamp, marker, payload),
        }
    }

    fn clear_partial_frame(&mut self) {
        self.h264.reset();
        self.vp8.reset();
    }
}

/// Cap on packets buffered per frame for the fallback path (~1.2MB at the
/// RTP chunk size); a frame larger than this only loses its fallback replay.
const MAX_FALLBACK_FRAME_PACKETS: usize = 1024;

/// Alternate-payload packets buffered for the frame currently being assembled
/// on an SSRC.
///
/// The primary depacketizer consumes the extension-stripped payload; this
/// buffer holds the unstripped alternate so the fallback depacketization is
/// only paid when the primary path fails DAVE decrypt for a completed frame
/// (previously every video packet was depacketized twice).
#[derive(Default)]
pub(super) struct FallbackFrameBuffer {
    pub(super) timestamp: u32,
    last_sequence: u16,
    /// True when at least one packet carried an alternate payload that
    /// differs from the primary — replay is pointless otherwise.
    pub(super) has_distinct_payload: bool,
    /// `(sequence, marker, payload)` in arrival order.
    pub(super) packets: Vec<(u16, bool, Vec<u8>)>,
}

impl FallbackFrameBuffer {
    /// Buffer one packet, mirroring the primary depacketizer's reset
    /// behaviour on timestamp changes and sequence gaps.
    pub(super) fn push(
        &mut self,
        sequence: u16,
        timestamp: u32,
        marker: bool,
        payload: &[u8],
        distinct: bool,
    ) {
        let continuous = !self.packets.is_empty()
            && self.timestamp == timestamp
            && self.last_sequence.wrapping_add(1) == sequence
            && self.packets.len() < MAX_FALLBACK_FRAME_PACKETS;
        if !continuous {
            self.clear();
            self.timestamp = timestamp;
        }
        self.packets.push((sequence, marker, payload.to_vec()));
        self.has_distinct_payload |= distinct;
        self.last_sequence = sequence;
    }

    pub(super) fn clear(&mut self) {
        self.packets.clear();
        self.has_distinct_payload = false;
    }

    /// Depacketize the buffered alternate payloads with fresh state,
    /// returning the completed frame candidate if assembly succeeds.
    pub(super) fn replay_candidate(
        &self,
        ssrc: u32,
        codec: VideoCodecKind,
    ) -> Option<VideoFrameCandidate> {
        if !self.has_distinct_payload {
            return None;
        }
        let mut state = VideoDepacketizerState::new(codec);
        let mut candidate = None;
        for (sequence, marker, payload) in &self.packets {
            if let Some((frame, depacketizer_keyframe)) =
                state.push(ssrc, *sequence, self.timestamp, *marker, payload)
            {
                candidate = Some(VideoFrameCandidate {
                    frame,
                    depacketizer_keyframe,
                    used_fallback_payload: true,
                });
            }
        }
        candidate
    }
}

#[cfg(test)]
mod tests {
    use crate::rtp::VideoCodecKind;

    use super::FallbackFrameBuffer;

    #[test]
    fn fallback_frame_buffer_replays_only_distinct_payloads() {
        let mut buffer = FallbackFrameBuffer::default();
        // Payloads identical to the primary never replay — the primary
        // depacketizer already tried exactly these bytes.
        buffer.push(10, 90_000, true, &[0x65, 0xAA, 0xBB], false);
        assert!(
            buffer
                .replay_candidate(4201, VideoCodecKind::H264)
                .is_none()
        );
        buffer.clear();

        // Distinct alternate payloads replay into a complete frame candidate.
        buffer.push(11, 93_000, false, &[0x67, 0x01], true);
        buffer.push(12, 93_000, true, &[0x65, 0xAA, 0xBB], true);
        let candidate = buffer
            .replay_candidate(4201, VideoCodecKind::H264)
            .expect("marker packet should complete the replayed frame");
        assert!(candidate.used_fallback_payload);
        assert!(candidate.depacketizer_keyframe);
        assert!(candidate.frame.ends_with(&[0x65, 0xAA, 0xBB]));
    }

    #[test]
    fn fallback_frame_buffer_resets_on_gap_and_timestamp_change() {
        let mut buffer = FallbackFrameBuffer::default();
        buffer.push(10, 90_000, false, &[0x67, 0x01], true);

        // Sequence gap discards the partial frame, mirroring the primary
        // depacketizer.
        buffer.push(13, 90_000, false, &[0x68, 0x02], true);
        assert_eq!(buffer.packets.len(), 1);

        // A new timestamp starts a new frame.
        buffer.push(14, 93_000, true, &[0x65, 0xAA], true);
        assert_eq!(buffer.packets.len(), 1);
        assert_eq!(buffer.timestamp, 93_000);
    }
}
