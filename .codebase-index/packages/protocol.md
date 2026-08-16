# packages/protocol

`@clankie/protocol` — the shared wire-contract
package. Every zod schema and type that crosses a
process boundary in Clankie lives here: captain
lanes and presence, operator conversations,
Discord presence/voice, embodiment (asked play),
device pairing, person memory, browser tools, and
media generation. Depends on nothing but zod;
every other package and app imports from it.

Children:

- package.json — `@clankie/protocol`, zod-only
- src/ — one module, `index.ts`, holds everything
- test/ — vitest suites, one per contract area
- tsconfig.json — typecheck-only build

Design notes:

- Schemas are strict and bounded on purpose:
  unknown keys are rejected (not stripped), every
  string/collection is length-capped, and evidence
  records are built from ids/enums/numbers so free
  text is unrepresentable by construction.
- Frozen lookup tables (Discord action risk
  classes, embodiment state transitions, reserved
  event-stream namespaces) are exported constants
  so every process shares one authority.
- A little runtime logic lives beside the schemas:
  the operator-conversation service client,
  `eventStreamKindForId`, and the generated-media
  / browser-artifact ref checks.
