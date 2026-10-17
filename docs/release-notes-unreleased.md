# Unreleased

## Rivals moves out of core; external game extensions (VUH-2419)

Spider-Man (Rivals) is now an external game extension in the Rivals Agent
repository (`clankie-extension/`). `clankie rivals`, `/rivals`, the bundled
`rivals` skill and the `gameplay.rivalsUrl` setting are removed; a saved
`rivalsUrl` is dropped on load. The bridge stays disabled (VUH-1325).

Any game can now live outside this repository: `clankie games extensions add
MODULE [KEY=VALUE...]` installs one by absolute module path and `remove MODULE`
uninstalls it, applying on restart. See `docs/rivals.md` and
`packages/game-extension/README.md`.

## Working preferences (VUH-2256)

Projects gain a started-issue WIP cap, owner-loop cadence (silent, milestones or
landings), lead and worker defaults, and plan/model constraints. Hires use
observed account capacity and record their selection and job-based effort.

These prompt-only controls are retired from editable settings:

| Retired setting                                    | Replacement                                                |
| -------------------------------------------------- | ---------------------------------------------------------- |
| Global and project `fleet.size`                    | The existing numeric worker cap                            |
| Global and project `fleet.models`                  | Usage-aware admission, profiles and plan/model constraints |
| Global and project `autonomy.fleet.verification`   | The actual work, review and landing evidence contracts     |
| Global and project `autonomy.fleet.reportingStyle` | Owner-loop reporting cadence                               |
| Global `fleet.hire.effort`                         | Per-hire effort and its job-based reason                   |

Exact saved values remain in a read-only `retiredWorkingPreferences` migration
receipt. Compatibility responses retain their old fields; they no longer accept
edits to these controls. Configuration changes still use the revision-fenced API.

Owner decision asks gain a default action and deadline. Expiry informs the lead
and owner; it never fabricates an owner answer, approves a gate, or grants money
or account authority.
