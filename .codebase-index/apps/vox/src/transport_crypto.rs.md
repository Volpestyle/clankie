# apps/vox/src/transport_crypto.rs

Implements Discord's AES-256-GCM and XChaCha20-Poly1305 `rtpsize` transport modes with a monotonic 32-bit send nonce. It borrows the session key to construct each cipher; the deserialized source buffer is `Zeroizing` in `voice_conn/protocol.rs`, while this module does not add an explicit zeroizing `Drop` for the cipher's internal key schedule. RTP AAD is recomputed from fixed headers, CSRCs, and extension prefixes; explicit-AAD decrypt supports RTCP.
