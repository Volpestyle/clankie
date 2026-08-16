# pnpm-workspace.yaml

Declares the workspace globs — apps/_,
integrations/_, packages/* — plus pnpm policy
knobs shared across them.

- allowBuilds: postinstall scripts permitted only
  for @discordjs/opus, esbuild, and node-pty;
  denied for @google/genai and protobufjs.
- catalog: single source of truth for shared dep
  versions (typescript 5.9.3, vitest 4.1.10,
  zod 4.4.3, pino 10.3.1, yaml 2.9.0, tsx
  4.23.0) referenced via `catalog:` in package
  manifests.
- minimumReleaseAgeExclude: the four
  @earendil-works pi packages at 0.84.2 are
  exempt from pnpm's minimum-release-age
  supply-chain delay.
- patchedDependencies: applies the tracked
  `@earendil-works/pi-tui@0.84.2` ghost-text patch.
