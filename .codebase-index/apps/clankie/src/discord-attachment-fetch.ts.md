# apps/clankie/src/discord-attachment-fetch.ts

The one place an untrusted Discord attachment
URL becomes bytes the model can see, so every
bound lives here: host allowlist (Discord CDN
only, https only), no redirects (`redirect:
"error"`), size ceiling checked on both the
declared Content-Length and the bytes actually
read, media type re-checked against what the CDN
actually serves, and a 10s abort timeout.

`fetchDiscordAttachment()` returns a
`data:<type>;base64,...` URL;
`createDiscordAttachmentResolver()` resolves a
turn's attachments concurrently and drops
failures — a failed image costs the picture,
never the turn (ADR 0072); the caller reports
the dropped count.
