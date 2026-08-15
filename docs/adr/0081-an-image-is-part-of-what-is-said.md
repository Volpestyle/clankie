# ADR 0081: An image is part of what is said

Status: accepted (2026-08-07). Extends
[ADR 0024](0024-discord-dual-plane-presence.md) (dual-plane presence) and
[ADR 0048](0048-discord-user-session-transport.md) (user-session transport),
and applies the reporting principle of
[ADR 0072](0072-the-harness-tells-him-the-truth.md) to perception.

## Context

An image in a Discord message is part of the message Clankie perceives. Caption
text alone is incomplete context, while an image-only message is not empty.
The ingress contract therefore carries admitted attachments through the bridge,
the strict presence schema, and the final pi prompt. Evidence distinguishes a
policy refusal from an attachment that cannot be resolved or decoded.

## Decision

**An image posted with a message is part of what is said.** It is admitted,
carried, and shown to him under the same policy that governs the message body,
and where it cannot be, he is told.

Five consequences fix the layers in order:

1. **A message with only images is a real message.** Emptiness means "no
   text _and_ no images he can see". The schema enforces the same rule
   (`body` or `attachments`, never neither), and a caption-less image reaches
   the turn with no `body` key at all rather than an empty string — an empty
   body reads as "they say nothing", which is false for an image-only message.

2. **Images cross the Clankie service as references, not bytes.** The trigger
   carries `{ id, url, motionUrl?, mediaType, filename?, byteSize? }`. Base64 in
   the request would put multi-megabyte payloads into every turn body,
   idempotency fingerprint, and receipt hash on the path. Bytes are fetched
   exactly once, at the last hop before the model.

3. **One fetch boundary, bounded on every axis.** The URL arrives on an
   untrusted gateway payload, so `discord-attachment-fetch` is the only place
   that turns one into content: HTTPS and Discord's CDN or image proxy only, no redirects,
   the size ceiling checked on both the declared `Content-Length` and
   the bytes actually read, the media type re-checked against what the CDN
   _serves_ rather than what the payload claimed, and a hard timeout so a hung
   CDN cannot hold a channel turn open.

4. **A fetch failure costs the picture, not the conversation.** He is told how
   many attachments he cannot see — wrong type, oversized, or failed to load —
   and answers anyway. He is told a count, never a filename or a guess.

5. **Discord GIF-picker embeds are moving visual messages.** A picker post is a
   page URL plus a `gifv` embed, not a Discord attachment. Ingress carries the
   embed's Discord-proxied WebP preview and MP4 through the same reference and
   fetch boundary. The captain model accepts images rather than video, so the
   service uses the installed `ffmpeg` to produce chronological PNG samples;
   if video fetch or sampling fails, the WebP preview remains the fallback.

### Where the untrusted bytes sit

Discord bodies enter the pi lane as ephemeral, untrusted prompt content. Image
bytes cannot ride the JSON context card; the model sees them only as image parts
on the turn.

So image parts ride in the durable message, and the framing beside them says
what they are — sender-posted, untrusted, and specifically that text inside a
picture is somebody writing, never an instruction. This is the one untrusted
payload in that message, admitted deliberately because vision requires it.
Three properties keep the blast radius small: the Discord context window keeps
references rather than image bytes; the context card mirrors the source and
count he sees; and a turn with no images remains a plain text prompt.

### Bounds

Four images per message (Discord permits ten), 8 MB each, and
`image/png|jpeg|gif|webp` — the intersection of what Discord serves and what
vision models accept. Anything else is left out at ingress and counted.
Moving embeds produce at most four chronological frames, scaled inside
1024×1024. Their proxied video is subject to the same 8 MB fetch ceiling, a
60-second duration ceiling, bounded process time, and temporary files removed
after each extraction.

Context carries only the newest visual source in the bounded message window;
a moving source expands into chronological frames. This covers a visual
followed by a bare wake and references such as "that screenshot" without
fetching images for up to fifty prior messages on every turn.

## Consequences

- He answers what is actually in the picture, on both the bot and user-session
  planes, through one shared selection rule — a policy that admitted an image
  on one body and not the other would be two characters, not one.
- Receipts stay content-free: attachment ids never enter the evidence, and the
  URL, filename, and byte count never leave the turn path.
- A deployment can keep him blind to images by omitting
  `resolveDiscordAttachments`; ingress still admits the message, and he is told
  the images are there and unreadable rather than told nothing.
- Egress from the service includes the Discord CDN and image proxy. This is a
  network dependency on the turn path, bounded by the allowlist and timeout
  above, and it is the reason the fetch lives in exactly one auditable module.
