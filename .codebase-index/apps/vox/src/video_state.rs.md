# apps/vox/src/video_state.rs

Parses Discord remote video-state payloads, converts stream descriptors, tracks SSRC/RTX bindings, and emits normalized state changes. It also builds outbound active/inactive video announcements and updates the negotiated codec used by receive state.
