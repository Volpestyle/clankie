# apps/gba-mcp/scripts/probe.ts

Drives the server the way a coding harness
does: spawns it over stdio through the real
MCP client SDK and prints what each call
returned. A unit test proves the schema;
only this proves external usability.

Checks, in order: tool listing, observe
(text + image parts), an accepted button
press, a protocol-schema refusal (button
"turbo"), an emulator-catalogue refusal
(999999 frames — past protocol validation,
exercising the adapter's fail-closed path).
With `CLANKIE_GBA_PROBE_HOLDER` set it also
walks the possession flow: possess, act
with the token, refuse an unnamed holder,
and confirm acting fails again after
release. Run via
`pnpm --filter @clankie/gba-mcp probe`.
