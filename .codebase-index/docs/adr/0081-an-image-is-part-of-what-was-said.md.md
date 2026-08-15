# docs/adr/0081-an-image-is-part-of-what-was-said.md

Inbound Discord images reach him: an image posted
with a message is admitted under the same policy
as the text, an image-only message is a real
message, and where he cannot see one he is told a
count (never a filename or a guess).

Read for the perception pipeline: images cross as
references, bytes fetched exactly once at the
last hop through the single bounded
`discord-attachment-fetch` boundary (HTTPS +
Discord CDN only, no redirects, double size
check, served-type re-check, hard timeout).
Bounds: 4 images, 8 MB, png/jpeg/gif/webp. Image
parts ride the durable message with framing that
marks them sender-posted and untrusted; text
sessions stay fresh per turn so bytes never
accumulate.
