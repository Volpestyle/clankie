# apps/vox/src/voice_conn/handshake.rs

Reads Discord Hello, Ready, and Session Description payloads under fixed timeouts, buffering unrelated text/binary opcodes for replay into the live reader. It also performs the UDP discovery exchange that determines the externally visible address and port.
