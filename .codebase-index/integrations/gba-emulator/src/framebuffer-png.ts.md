# integrations/gba-emulator/src/framebuffer-png.ts

`encodeFramebufferPng` — encodes an RGB565
mGBA framebuffer as a truecolor PNG using only
node:zlib, no external encoder. GBA pixel art
deflates to single-digit kilobytes, which is
what makes per-frame PNG a sufficient
transport for the activity plane.

Supports nearest-neighbour upscale (scale 1-8)
so vision models can read tiles — identical
picture, just larger. Fails closed on invalid
scale, dimensions, or truncated buffers.
