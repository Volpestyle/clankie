# apps/vox/src/video.rs

Defines the in-memory video data model: serializable resolutions/stream descriptors, normalized user subscription preferences and delivery counters, and a remote user's audio/video SSRC plus stream list. It selects the preferred active stream by requested type, preferred SSRC, resolution, and quality; Discord opcode parsing, SSRC binding maps, announcements, and codec updates belong to `video_state.rs`.
