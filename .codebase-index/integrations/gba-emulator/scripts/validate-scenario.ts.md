# integrations/gba-emulator/scripts/validate-scenario.ts

`scenario:validate [outputDir]` — runs the
frozen verdant-path double scenario end to end
(`runFrozenGbaScenario`) after checking the
fixture's sidecar hash, writes the evidence
files (report/events/decisions/semantic
events), and asserts the report's artifact
hashes match the emitted bytes. Prints a
validation summary; evidence lands in the
requested dir or a temp dir.
