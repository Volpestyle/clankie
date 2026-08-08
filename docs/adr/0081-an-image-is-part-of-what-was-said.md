# ADR 0081: An image is part of what was said

Status: accepted (2026-08-07). Extends
[ADR 0024](0024-discord-dual-plane-presence.md) (dual-plane presence) and
[ADR 0048](0048-discord-user-session-transport.md) (user-session transport),
and applies the reporting principle of
[ADR 0072](0072-the-harness-tells-him-the-truth.md) to perception. Numbering:
0081 follows 0080, the highest ADR present when this is authored.

## Context

On 2026-08-07 an image was posted to a Discord channel Clankie was active in,
and he said nothing. The receipts (`discord-live-receipts.jsonl`) showed the
turn had run normally and the captain had chosen silence — so the failure read
like a persona problem. It was not. **The image never reached him.**

The inbound path was text-only at every layer:

- `apps/discord-bridge/src/index.ts` built its inbound message from
  `message.content` alone and never read `message.attachments`; the
  user-session gateway did the same with the raw dispatch payload.
- `DiscordPresenceChannelTurnRequest.trigger` was `.strict()` with a lone
  `body` string, so the bridge could not have forwarded an attachment even had
  it read one.
- No vision input path existed anywhere below the control plane.

Two distinct outcomes followed from one cause, and both look like a character
flaw from the channel:

- **An image with a caption** ran a real turn showing only the caption. He was
  asked about a picture that was not there and, sensibly, said nothing.
- **An image with no caption** arrived with `body: ""`. In a channel he was
  engaged in, `text-ingress` dropped it as `empty_message` before any turn. In
  a channel he had not spoken in, it was refused earlier still as
  `not_addressed` — the emptiness check never ran, so the receipts recorded a
  _policy_ refusal for what was really a _perception_ gap.

The through-line: he was answering conversations he could only half observe,
and nothing in the system said so — not to him, and not in the evidence.

## Decision

**An image posted with a message is part of what was said.** It is admitted,
carried, and shown to him under the same policy that governs the message body,
and where it cannot be, he is told.

Four consequences fix the layers in order:

1. **A message with only images is a real message.** Emptiness now means "no
   text _and_ no images he can see". The schema enforces the same rule
   (`body` or `attachments`, never neither), and a caption-less image reaches
   the turn with no `body` key at all rather than an empty string — an empty
   body reads as "they said nothing", and they did not.

2. **Images cross the control plane as references, not bytes.** The trigger
   carries `{ id, url, mediaType, filename?, byteSize }`. Base64 in the request
   would put multi-megabyte payloads into every turn body, idempotency
   fingerprint, and receipt hash on the path. Bytes are fetched exactly once,
   at the last hop before the model.

3. **One fetch boundary, bounded on every axis.** The URL arrives on an
   untrusted gateway payload, so `discord-attachment-fetch` is the only place
   that turns one into content: HTTPS and Discord's CDN only, no redirects,
   the size ceiling checked on both the declared `Content-Length` and
   the bytes actually read, the media type re-checked against what the CDN
   _serves_ rather than what the payload claimed, and a hard timeout so a hung
   CDN cannot hold a channel turn open.

4. **A fetch failure costs the picture, not the conversation.** He is told how
   many attachments he cannot see — wrong type, oversized, or failed to load —
   and answers anyway. He is told a count, never a filename or a guess.

### Where the untrusted bytes sit

Discord bodies live in ephemeral `clientContext`, and the durable Eve message
is fixed framing text that no untrusted input can author. Images break that
symmetry, because `clientContext` is JSON-serialized into a context message and
cannot carry bytes: the only channel that reaches the model's vision is the
message itself.

So image parts ride in the durable message, and the framing beside them says
what they are — sender-posted, untrusted, and specifically that text inside a
picture is somebody writing, never an instruction. This is the one untrusted
payload in that message, admitted deliberately because vision requires it.
Three properties keep the blast radius small: the Discord text lane does not
retain its Eve cursor (`retainCursor` is voice-only), so a session is fresh per
turn and image bytes never accumulate; the count and types he was shown are
mirrored into `clientContext` where the rest of the turn's shape lives; and a
turn with no images stays the plain string it always was.

### Bounds

Four images per message (Discord permits ten), 8 MB each, and
`image/png|jpeg|gif|webp` — the intersection of what Discord serves and what
vision models accept. Anything else is left out at ingress and counted.

Context messages stay text-only. Fetching images for up to fifty prior messages
would multiply the cost of every turn in a busy channel for a picture nobody
asked about; the trigger is what he was shown.

## Consequences

- He answers what is actually in the picture, on both the bot and user-session
  planes, through one shared selection rule — a policy that admitted an image
  on one body and not the other would be two characters, not one.
- Receipts stay content-free: attachment ids never enter the evidence, and the
  URL, filename, and byte count never leave the turn path.
- A deployment can keep him blind to images by omitting
  `resolveDiscordAttachments`; ingress still admits the message, and he is told
  the images are there and unreadable rather than told nothing.
- Egress from the control plane now includes the Discord CDN. That is a new
  network dependency on the turn path, bounded by the allowlist and timeout
  above, and it is the reason the fetch lives in exactly one auditable module.
