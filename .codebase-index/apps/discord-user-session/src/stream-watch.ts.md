# apps/discord-user-session/src/stream-watch.ts

`startStreamWatch()` owns screen-share watch/publish sessions on the user-account body. It creates or accepts a `VoxStreamClient`, joins muted/deafened unless this body is the mouth, sends Discord Go Live opcodes, hands stream-server credentials to Vox, watches one allowlisted remote stream at a time, and posts rate-limited decoded stills to the service projection.

The same controller publishes a URL or deduplicated local activity PNG snapshots, maps pause/resume/stop to both gateway and native commands, retries connection once a delayed voice session id appears, and emits watch/publish receipts only after native transport readiness.
