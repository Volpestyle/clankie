# apps/clankie/scripts/setup-yaak.py

Creates a local Yaak workspace for the Clankie HTTP API, replacing an existing workspace with the same name. Requests are grouped by authority and use Yaak templates to read bearer credentials from the macOS Keychain without copying tokens into the workspace.

The generated catalog covers safe reads plus explicitly labelled state-changing probes for operator, captain, Discord, embodiment, browser/media, pairing, and device routes.
