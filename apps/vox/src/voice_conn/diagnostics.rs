//! DAVE-marker helpers for video decrypt diagnostics.

/// True when the frame ends with the DAVE magic marker (0xFA 0xFA).
pub(super) fn has_dave_marker(frame: &[u8]) -> bool {
    frame.len() >= 2 && frame[frame.len() - 2] == 0xFA && frame[frame.len() - 1] == 0xFA
}

/// Supplemental-section size byte from the DAVE trailer, when the marker is
/// present.
pub(super) fn dave_trailer_supp_size(frame: &[u8]) -> Option<usize> {
    (has_dave_marker(frame) && frame.len() >= 3).then(|| frame[frame.len() - 3] as usize)
}

/// Count 0xFA 0xFA byte pairs inside the frame body — more than one suggests
/// the sender encrypted per-NAL or per-packet rather than per-frame, and the
/// depacketized assembly is wrong.
pub(super) fn count_internal_dave_markers(frame: &[u8]) -> u32 {
    if frame.len() < 4 {
        return 0;
    }
    let mut count = 0u32;
    for i in 0..frame.len() - 1 {
        if frame[i] == 0xFA && frame[i + 1] == 0xFA {
            count += 1;
        }
    }
    count
}
