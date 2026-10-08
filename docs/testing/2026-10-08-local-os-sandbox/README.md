# Local macOS OS boundary — VUH-1804

This is disposable native-process evidence for
[ADR 0257](../../adr/0257-a-lowered-local-runtime-keeps-an-os-boundary.md),
not activation of James's running Mac service or proof of a live provider hire.

The covering integration is
[local-sandbox.integration.test.ts](../../../apps/tui/test/local-sandbox.integration.test.ts).
It prepares an installed-runtime fixture with real Node/native loader files,
an isolated settings store, private home, approved workspace and ordinary
owner-readable outside data. No tokens, existing credentials, owner stores,
existing Herdr daemon, simulator or game body are used.

| Boundary                                                                   | Observed result                                       |
| -------------------------------------------------------------------------- | ----------------------------------------------------- |
| Service reads/writes its approved workspace                                | Succeeds                                              |
| Service and inherited Node worker read outside data                        | Both refuse with `EPERM`                              |
| Workspace symlink to outside data                                          | `EPERM`                                               |
| Write installed runtime or hard-link it into a workspace                   | `EPERM`                                               |
| Remove protected launch controls from the bounded process                  | `EPERM`; envelope remains                             |
| Native `openpty` inside the boundary                                       | Creates and uses its own PTY                          |
| Read a disposable PTY created outside the boundary                         | `EPERM`                                               |
| Connect private Unix socket                                                | Succeeds                                              |
| Connect outside Unix socket directly or through a private-home symlink     | `EPERM`                                               |
| Change settings to screen or use the owner access API to raise the ceiling | Effective level stays shell; API returns 400          |
| Connect a named local daemon, including manually inserted binding          | Refuses; no binding or named-local roster             |
| Set the locator in an unrestricted process                                 | Verification refuses its readable outside probe       |
| Mismatched profile, malformed envelope or canonical overlapping grants     | Refuses                                               |
| Real supervisor starts the prepared service                                | Healthy HTTP response reports shell ceiling           |
| Owner removes controls and launches a new unrestricted child               | Original outside data is readable again; no reinstall |

The existing machine-access integration separately covers authenticated owner
API/CLI changes and denied tool effects. Service supervision and Herdr tests
cover their unchanged ordinary-launch paths. macOS cases are explicitly skipped
on other platforms; no equivalent Linux/Windows OS claim is made.

Remaining owner work: provision the private home's continuing service state,
credentials, harnesses and necessary resource directory grants; stop existing
unrestricted workers/service deliberately; lower/start/hire and capture a real
worker's outside-read refusal; stop/remove/start and capture restored access.
Preparation does not migrate conversation, memory or pairing stores. Existing
stores remain intact. VUH-1804 stays open for this live proof. No live settings,
OS permissions, accounts or processes were changed by this verification.
