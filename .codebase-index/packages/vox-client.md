# packages/vox-client

Apache-2.0 TypeScript process client for the separately AGPL ClankVox executable. It discovers/builds the binary, owns child lifecycle, validates bounded framed IPC, exposes typed voice/music/watch/publish commands and events, and keeps native implementation licensing explicit.

- `package.json` — client scripts and dependencies.
- `README.md` — process boundary, lifecycle, and rollout guide.
- `src/` — binary resolution, child process, framing, schemas, and client API.
- `test/` — IPC, validation, lifecycle, and smoke tests.
- `tsconfig.json` — TypeScript configuration.
