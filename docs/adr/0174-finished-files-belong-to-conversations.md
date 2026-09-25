# 0174. Finished files belong to conversations

Accepted 2026-09-20.

## Context

Clankie can create reports, spreadsheets, presentations, and site bundles, but
a filesystem path is not a usable delivery. A phone cannot dereference the
Mac's path, a public download URL would outlive device authorization, and a
bearer in a URL would leak through history and logs. The durable conversation
already owns the message that says the work is finished and the retention
window in which the result remains meaningful.

## Decision

A deliberate `deliver_file` tool and the local `publish_file` service operation
copy one regular file from the conversation's real working directory into the
existing attachment root. Realpath containment rejects symlink and `..`
escapes. Files are capped at 15 MiB, stored with private permissions, and named
by an opaque artifact id with a SHA-256 manifest. The conversation appends a
strict `file` event containing only the id, safe filename, content type, size,
and hash. Reset, close, and retention pruning remove the conversation's bytes.

Downloads use `POST /operator/v1/artifacts/download` with the conversation and
artifact ids in a JSON body. Local clients authenticate with the captain bearer;
remote clients authenticate with their device session and require the `chat`
grant. The public gateway carries the same host-scoped application route inside
its encrypted envelope. No download URL contains a bearer, device secret, or
artifact capability. The host revalidates the manifest, size, and hash before
returning the exact bytes and published content type.

External native chats read their own source history on demand
([ADR 0188](0188-native-agent-chats-read-their-own-history.md)). When a requested
page contains an image path in an agent reply (png, jpeg, gif, webp; at most four
per reply), or an explicit Codex `ImageView`, the image is published through the
same store with the seat's working directory as its containment root. File events
appear in native order in the returned page; its text and tools are not copied
into the host log. Missing, outside-root or oversized files remain prose or are
skipped. Source paths never enter file events.

Clankie's own native head retains durable transcript folding. Its image delivery
is serialized, deduplicated and checkpointed after publication, with a bounded
retry for unavailable paths. The head's live Herdr working directory is its
containment root. All downloads require the owner's authorized device identity.

The app renders each event as its own block: an image shows inline, fetched
through the same authenticated download, and every other file is a card. The
image block shows its filename and a native loading indicator until both the
download and native image decode finish; a download or decode failure falls
back to the file card. A tap downloads through the injected authenticated
transport first, checks the published size and content type, then writes the
bytes to the private device cache and presents Quick Look.
Quick Look supplies native preview and share/save actions on both iPhone and
iPad. Discord machine-authorized turns use the same store and existing
hash-bound attachment resolver; ungranted social turns never receive the tool.

```mermaid
sequenceDiagram
    participant C as Conversation / captain
    participant S as Delivered-file store
    participant R as Relay + encrypted gateway
    participant A as iPhone / iPad app
    C->>S: publish path inside real working directory
    S-->>C: metadata + hash-bound attachment reference
    Note over C,S: a seat's reply publishes the images it names,<br/>contained by the seat's working directory
    C-->>A: durable file event
    A->>R: authenticated POST conversationId + artifactId
    R->>S: captain-authenticated byte request
    S-->>R: verified exact bytes + content type
    R-->>A: encrypted response envelope
    A->>A: private cache → Quick Look → share/save
```

## Consequences

The artifact is durable for exactly the conversation lifetime rather than a
second retention policy. Publishing remains local because it accepts a host
path; remote devices can retrieve but cannot ask the Mac to publish arbitrary
paths. The 15 MiB ceiling keeps relay and mobile memory bounded. Larger or
multi-file results are delivered as a deliberate archive or through a future
streaming object store if measured use requires it.

## Alternatives

- Signed public URLs were rejected because URL history becomes a second secret
  and revocation boundary.
- Direct native URL downloads were rejected because they bypass the injected
  encrypted device transport.
- Teaching every seat harness a publish command was rejected: a seat already
  says which image it means, and a rule per harness would have to be carried
  into every repo a seat works in.
- Keeping source paths in transcript events was rejected because paths disclose
  host layout and are meaningless off the host.
