# apps/tui/package.json

Manifest for `@clankie/tui`. Exposes the `clankie`
bin pointing straight at `bin/clankie.ts` (runs under
Node type stripping — no build). Scripts: `dev`/
`start` run `src/index.ts` via tsx, `build` and
`typecheck` are both `tsc --noEmit`, `test` is
vitest.

Depends on the workspace contracts and adapters
(`@clankie/protocol`, `api-client`,
`credential-broker`, `model-provider`,
`model-registry`, `observability`, `settings`), plus
`@earendil-works/pi-tui` (the differential terminal
renderer), `qrcode`, and `zod`.
