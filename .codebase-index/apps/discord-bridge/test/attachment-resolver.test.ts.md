# apps/discord-bridge/test/attachment-resolver.test.ts

Pins the filesystem attachment resolver: a
hash-bound ref resolves with the right content
type, a drifted hash is rejected, and a symlink
pointing outside the root fails with
`outside_root`. Uses real tempdirs, cleaned per
test.
