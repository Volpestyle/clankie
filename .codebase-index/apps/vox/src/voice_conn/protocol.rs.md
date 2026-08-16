# apps/vox/src/voice_conn/protocol.rs

Defines typed Discord voice opcode payloads and helpers for parsing, codec advertisement, select-protocol requests, and publish video descriptors. Session keys are zeroized and redacted from `Debug`, while role-aware negotiation advertises H264 send or H264/VP8 receive capabilities.
