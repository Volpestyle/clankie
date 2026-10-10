# ADR 0085: A picture he makes is something he says

Status: accepted (James, 2026-08-09). Widened by
[ADR 0088](0088-a-screenshot-is-something-he-shows-you.md) and extended for
long renders by
[ADR 0094](0094-a-render-that-outlives-the-turn-comes-back-to-the-room.md).
Doctrine profiles and approval envelopes mentioned in the original rationale
were later removed; the provenance-based conversational publication boundary
remains.

## Context

`@clankie/media-connector` provides provider-neutral image/video generation,
artifact hashing, and the pixel-art carve-out. The service, not the captain,
owns provider credentials and operator-selected models.

At ratification arbitrary `send_attachment` publication required an approval,
while a generated picture requested in conversation needed to behave like the
reply itself. Treating both paths identically either stopped every drawing for
ceremony or let arbitrary files masquerade as generated output. The approval
system is historical; the structural provenance distinction is still the
decision.

## Decision

Generation lives in the Clankie service. The owner chooses provider/model
configuration; a turn chooses the prompt. The generator resolves credentials
from the broker and returns a hash-bound artifact reference. Missing config,
credential failure, provider failure, or artifact bounds become a typed reason
Clankie can relay rather than an opaque failed turn.

A picture is conversational only when a governed tool captures it in the same
turn:

- the generator writes only beneath its governed artifact root;
- a successful media tool result writes the hash-bound reference into a
  host-owned turn capture;
- model text and arbitrary filesystem paths cannot set the capture; and
- a Discord reply attaches only a validated captured reference.

The attachment is captured, never asserted. The last successful generation in
a turn wins, so the model cannot attach a path by describing it.

Video remains a resumable asynchronous job. A bounded wait may return a request
id; a later call resumes that render rather than purchasing a duplicate. Remote
downloads are host-checked and byte-bounded because any URL fetched by the
service is an SSRF boundary. A redirect is followed only to another of the
provider's own hosts, and the credential never travels with it.

### Amendment: frames-to-video (VUH-2037, 2026-10-10)

A video can open on a first frame, end on a last frame and take after up to
three reference images. One picture as both first and last frame makes a loop,
which is how a sprite idle gets animated. Each picture is media he made (an
`artifactRef`) or the caller's own PNG, JPEG or WebP bytes as a data URI, never
a path the service reads. A render with frames goes to Google Veo, the
frames-to-video provider, unless the owner's `video_model` is already a Veo
model. Prompt-only video keeps the owner's choice. The rule lives in code, not
in the request, so a turn still never picks what to spend. Kling or another
frames-to-video provider joins as one more adapter.

Fleet workers reach this as `clankie_generate_video` on the tool bridge. Their
frames are usually files in their checkout, and a model cannot type a PNG as
base64, so the bridge alone takes absolute paths. It accepts them only from a
worker proven local by fleet admission, which can already read those files, and
it sends only bytes that are PNG, JPEG or WebP by their magic numbers. A fleet
joined over a bearer link may be on another machine and passes references or
data URIs only.

## Alternatives considered

- **Let the captain call providers directly** was rejected because it would put
  credentials and vendor response types in the agent runtime.
- **Allow any artifact under the attachment root** was rejected because prompt
  injection could turn unrelated private files into conversational media.
- **Require a separate publication ceremony for every generated reply** was
  rejected because it breaks the intended conversational surface.

## Consequences

- Generated pictures and short clips can ride the same settled reply that
  requested them.
- The blast radius is limited to a validated artifact captured from a successful
  governed tool result in that turn.
- Generation and publication remain separate auditable events even though this
  publication path is conversational.
- Surfaces that cannot display media may ignore the captured field without
  changing generation behavior.
- Current providers, model commands, artifact limits, and pending-render
  operation belong in the
  [TUI operating guide](../../apps/tui/README.md) and
  [media connector README](../../packages/media-connector/README.md).
