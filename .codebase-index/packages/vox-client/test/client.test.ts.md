# packages/vox-client/test/client.test.ts

Vitest unit coverage for the pure client boundary. It proves arbitrary-chunk control-frame reassembly, validates video and binary speaker-audio decoding including malformed sample lengths, resolves an existing owned binary candidate without environment configuration, and redacts session credentials plus signed URLs from child diagnostics.
