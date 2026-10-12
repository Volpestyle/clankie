# VUH-2029: configured project ownership during hiring

Blocker: `LOCAL-VUH-7`, filed by the Clankie Work lead in the built-in tracker
of tracker-research-20261008. The lead reported a refused `LOCAL-VUH-4` hire:
“This conversation and the new agent's folder belong to different projects.
Hire from the intended project's conversation.”

## Real service configuration

Read-only CLI reads of the deployed service confirmed:

| Field                     | Value                                                              |
| ------------------------- | ------------------------------------------------------------------ |
| Lead conversation         | `conv-4c11af56-0e37-4870-9294-bf307fc3c0d0`                        |
| Conversation workspace    | `/Users/james/dev/clankie`                                         |
| Requested owner project   | `clankie-work`                                                     |
| Registered primary folder | `/Users/james/dev/tracker-research-20261008`                       |
| Bound tracker project     | `cbd205ab-cad4-48b8-9724-7109410fc921`                             |
| Saved lead route          | That tracker UUID → that conversation                              |
| Project Auto              | On                                                                 |
| Project settings revision | `8fac6d0135d00a437d01b30ea4e13c9baf073ff1fd03c14d495b9279e48b38fe` |

Reads used `clankie project settings clankie-work`, `clankie linear routes`,
and `clankie conversations show ID --limit 1`. Private raw responses remain
under `.local/`; no service settings were changed and no live worker was hired.

## Change and verification

The source project now comes from the owner's explicit built-in/Linear lead
binding before folder fallback. A configured lead cannot claim another project
through its folder, and a lead owning several projects must name `projectId`.
Native source identity and role membership remain checked. Destination membership,
caps, owner policy, machine and account admission remain enforced; the current
saved binding is read again during admission.

The regression uses real persisted settings, registered disposable folders named
clankie and tracker-research-20261008, project HTTP routes, the hire ledger,
persona adoption and the existing executable native-protocol process fixture.
It retains the reported conversation/project UUIDs and deliverable. A cap of one
is an additional test constraint, not the observed live setting.

**Read-only service proof:** passed at 20:12:14Z. The production resolver, using
the captured service settings and the real registered folders, reproduces the
old `clankie` → `clankie-work` refusal and resolves the configured owner to
`clankie-work`. Another requested project and a mismatched destination remain
refused. The sanitized result is [proof.json](proof.json).

**Focused checks:** 73 tests passed across `fleet-resource-hire.integration`,
`project-hires` and `captain-hire`. The new regression admits one native-protocol
fixture hire and retains the cap, checks the real process identity, rejects
another project/destination, and rechecks a revoked binding after preparation.
Explicit source and documentation formatting passed. The exact-tree landing
gate belongs to the integrator.

The installed Work lead's live retry belongs to the lead after deployment;
this proof does not claim a successful live Codex hire. The native-protocol
fixture is an ordinary executable helper, not the installed Codex TUI.
