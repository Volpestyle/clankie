# apps/vox/src/voice_conn/diagnostics.rs

Provides three pure DAVE-video inspection helpers: detect the trailing `0xFA 0xFA` marker, read its supplemental-section size byte, and count marker pairs in an assembled frame. It performs no logging, formatting, or rate limiting itself; the UDP receive caller decides when and how often to emit diagnostics.
