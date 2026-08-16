# docs/adr/0081-an-image-is-part-of-what-is-said.md

Inbound Discord images are part of the admitted
message: image-only posts are real turns, references
cross service contracts, and bytes are fetched
once at the final model hop. Failures remove only
the picture and tell Clankie a count, never a
filename or guess.

The fetch boundary is HTTPS/CDN-only, redirect-
free, size/type/time bounded, and content-free in
receipts. GIF-picker video is sampled through
ffmpeg into at most four chronological PNG frames,
with the proxied WebP preview as fallback.
