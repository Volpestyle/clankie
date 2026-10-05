# Composer transcription

VUH-1569 / VUH-1571 add a paired-device API for turning a short recording into
an editable composer draft. This is independent of live voice. Local recognition
belongs to the companion app; self-hosted Clankie does not upload audio to a
provider. Managed transcription remains gated on integration, deployment and
James's device and provider checks.

The request authority is an active paired device with chat access. The device
uses its existing encrypted transport and session credential. The Clankie
bearer, an operator bearer and a support device cannot authorize this API.
Managed calls carry the body's signed tenant, installation and current device
key binding; the hosted service checks current eligibility and device revocation
before reserving usage and before calling its provider.

## API

The node-free contract is
[`@clankie/protocol/composer-transcription`](../packages/protocol/src/composer-transcription.ts).
[`createComposerTranscriptionApi`](../packages/api-client/src/composer-transcription.ts)
accepts the caller's paired-device request transport. It never retries a write.
All paths below are under `/v1/composer/transcription`.

Headless consumers use the same API with a paired-device session. The launcher
currently stores operator credentials rather than an app's paired-device
session; this feature does not add a launcher credential store or let that
ambient credential authorize transcription.

| Method | Path       | Purpose                                                                        |
| ------ | ---------- | ------------------------------------------------------------------------------ |
| GET    | `/status`  | Local/managed availability, recording bounds and remaining included allowance. |
| POST   | `/begin`   | Open one recording using a UUID `requestId` and bounded `audioBytes`.          |
| POST   | `/chunk`   | Append a bounded base64 chunk at an exact byte offset.                         |
| POST   | `/commit`  | Validate the completed audio and request transcription once.                   |
| POST   | `/receipt` | Reconcile the same request after an uncertain response.                        |
| POST   | `/cancel`  | Discard that request and its draft result.                                     |

Chunks are at most 256 KiB before base64 encoding. The existing encrypted
transport's message limit is unchanged. Audio must be mono 16 kHz, 16-bit PCM
WAV, with at most three minutes of sample data and bounded RIFF metadata. Both
the body and the hosted service derive duration from the bytes rather than a
client's claimed duration. A request id belongs to one paired device; another
device cannot read or cancel its receipt.

The app records only after an explicit mic action and uploads only after Stop.
It inserts a completed transcript at the captured selection if the draft and
conversation still match, and Send remains explicit. Cancel, interruption,
backgrounding or a changed conversation prevents late insertion. A cloud
failure or exhausted allowance preserves the draft and offers a separate local
dictation action where supported. It never silently uploads a local recording
or repeats a cloud submission after uncertainty.

Audio and transient draft results have bounded lifetimes and are excluded from
logs. Usage records contain accounting metadata. The hosted service owns its
provider interface, credentials and included allowance; none lives in the
public body or reaches the device. Numeric plan limits and the unpublished
provider privacy copy are maintained in the private hosted-service repository.

The body deletes audio and transient text at its ten-minute expiry, on Cancel
and at restart. It keeps at most 100,000 metadata-only UUID tombstones so an old
request cannot be submitted again after restoring disk state. New uploads are
limited to eight globally, two per device and six starts per device per minute;
capacity refusal leaves local dictation available.
