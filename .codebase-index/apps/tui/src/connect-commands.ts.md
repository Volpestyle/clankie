# apps/tui/src/connect-commands.ts

Builds the owner-facing `/connect` catalog for Linear and email. `buildConnectCommands()` guides secrets into the credential broker and public account/server settings into `settings.json`; status formatting and provider probes report exactly what remains incomplete.

Exports email presets, Linear endpoints, and compatibility argument normalization for older `/auth mcp linear` phrasing.
