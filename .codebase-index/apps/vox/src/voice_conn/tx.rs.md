# apps/vox/src/voice_conn/tx.rs

Implements outbound connection operations: paced Opus RTP, H264 single-NAL/FU-A packetization, stream publish speaking/video announcements, media sink wants, and protected RTCP feedback. Packet construction preserves Discord's RTP extension and AEAD AAD rules before UDP send.
