# Unreleased

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
