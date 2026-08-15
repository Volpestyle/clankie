# apps/clankie/test/operator-auth.test.ts

Credential-backed operator authentication with
an in-memory store: a fresh store bootstraps a
credential that reaches the device list with no
env token, and one rotation invalidates the old
credential immediately (old 401, new 200)
without restarting the app — the per-request
resolve is the point.
