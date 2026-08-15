# apps/discord-bridge/src/attachment-resolver.ts

createFilesystemAttachmentResolver: resolves a
hash-bound artifact ref (`sha256:<hex>:<relpath>`)
to bytes for presence attachment actions.

Safety: refuses absolute/relative-escape paths,
realpath-containment inside the configured root
(defeats symlink escape), 25 MiB cap, and a
timing-safe sha256 comparison so drifted content
never posts. Infers content type from extension
for common image/video formats.
