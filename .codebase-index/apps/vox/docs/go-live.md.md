# apps/vox/docs/go-live.md

Detailed Discord Go Live publish and screen-watch transport guide: gateway stream opcodes, media-server negotiation, H264 packetization/decode, readiness evidence, subprocess-backed source handling, and bounded IPC events. End-to-end observation currently requires in-process OpenH264 `decoded_video_frame`; raw VP8 transport events have no product decoder.
