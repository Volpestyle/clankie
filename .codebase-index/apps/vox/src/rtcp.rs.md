# apps/vox/src/rtcp.rs

Builds RTCP headers and transport-protected feedback packets with correct 32-bit word lengths. The connection send path uses it for receiver reports, PLI, and FIR over Discord's RTP-size AEAD modes.
