# apps/vox/src/vp8.rs

Parses VP8 RTP payload descriptors and reassembles raw VP8 frame bytes by timestamp and marker, resetting partial state on gaps or frames above the shared 8 MiB cap. It reports whether partition zero identifies a keyframe; it does not add IVF or other container framing, which is the consuming fallback decoder's responsibility.
