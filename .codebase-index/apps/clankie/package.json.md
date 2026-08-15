# apps/clankie/package.json

Manifest for `@clankie/clankie` (private,
ESM, v0.2.0). Runs from source with `tsx`
(`dev`/`start` = `tsx src/index.ts`); `build`
and `typecheck` are both `tsc --noEmit`.

Depends on most workspace packages (protocol,
credential-broker, gba-emulator, media-connector,
settings, ...), the pi agent stack
(`@earendil-works/pi-agent-core`, `pi-ai`,
`pi-coding-agent` 0.84.1), Hono for HTTP, plus
typebox and zod for schemas. `free-play-live`
script runs the dev playthrough; tests via
vitest.
