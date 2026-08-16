# apps/vox/src/rtp.rs

Defines Discord payload types, video codec metadata, RTP header builders/parsers, extension constants, and packet size limits. Helpers strip padding and select between extension interpretations while keeping payload and AEAD AAD boundaries distinct.
