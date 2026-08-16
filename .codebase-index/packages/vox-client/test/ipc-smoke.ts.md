# packages/vox-client/test/ipc-smoke.ts

Executable end-to-end IPC readiness probe. Passing `debug` selects `apps/vox/target/debug/clankvox`; otherwise normal client resolution applies. The probe fails if the child is unavailable, emits an error, or does not report `process_ready` within five seconds, prints the resolved binary on success, and always closes the client.
