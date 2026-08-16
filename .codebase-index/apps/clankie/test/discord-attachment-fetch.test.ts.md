# apps/clankie/test/discord-attachment-fetch.test.ts

The attachment fetcher's trust boundary: returns
a data URL with `redirect: "error"` set,
refuses non-CDN hosts and plain http before
dialling (SSRF probes included), refuses what
the CDN actually serves when it is not a
readable image, enforces the size ceiling on
both a lying Content-Length and the real bytes,
keeps siblings when one attachment fails, and
gives up on a hung CDN via the timeout instead
of holding the turn open.
