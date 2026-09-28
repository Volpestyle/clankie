# Bundled working skills

Clankie supplies reusable guidance for leading, reviewing, tracking work and
shipping changes. Tool and domain references can remain in the owner's global
skill selection. Skills are available context, not mandatory rituals: the task,
repository and user's authorization still govern their use.

The authoring source for reusable process skills is
[Volpestyle/skills](https://github.com/Volpestyle/skills). The pinned revision and
selected directories are in [the manifest](../vendor/opinionated-skills.json).
The snapshot retains its MIT license; edit upstream and refresh the snapshot.
The existing `@volpestyle/lead-skills` archive also comes from that repository's
`agent/` directory. It is a distribution artifact, not a second authoring source.
Clankie's own product skills remain authored in `.agents/skills`.

| Area            | Skills                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Leadership      | lead, swarm-lead, herdr-lead, co-w, herdr-handoff, research-team, shared-checkout                                      |
| Work tracking   | work-items, work-tracking, linear-issues, linear-orient, linear-plan, linear-write, linear-grind, linear-agent-session |
| Review          | reflect, blast-radius, robust-review, interrogate, conventions, perf-review, docs-review, repo-evolution-review        |
| Delivery        | c, p, pr-description, mr-link, testing-archive                                                                         |
| Working methods | solution-space, update-review-ethos                                                                                    |

The bundle also retains the product/tool skills `this-machine`, `trace-clankie`,
`computer-use-delegation`, `desktop-control` and `swarm-mcp`. `work-tracking`
retains tracker policy; `work-items` owns Clankie's tracker mechanics.
`clankie-mode` and `clankie-perf` are checkout-only links in `.agents/dev-skills`,
excluded from releases. They require the sibling skills checkout.

## Harness discovery

- Clankie's Pi sessions use `clankieSkillRoots`; the Claude operator seat uses
  `integrations/claude-plugin/skills`.
- Local Claude hires receive `--plugin-dir integrations/worker-skills`, a
  skills-only plugin named `clankie-work`. It installs neither Clankie's identity
  nor operator hooks in the worker.
- Local Pi hires receive `--skill <body>/.agents/skills`.
- Local Codex hires receive a private `CODEX_HOME` under the body's state directory
  and keep `--no-daemon`. The overlay copies configuration and hooks, preserves
  existing hook trust hashes for the identical hook file, and links the owner's
  existing authentication, plugin and transcript state. Bundle names take
  precedence over skills in the owner's Codex directory. No global skill links
  or configuration files are installed or rewritten. Shell startup must preserve
  an inherited `CODEX_HOME`. File-backed login was verified; an account whose
  credentials are bound only to the original home's Keychain identity needs a
  separate canary before adoption.

These launch changes take effect after the service reloads this revision. They
are implemented for local `hire_agent`/seat creation. Remote fleet hires retain
existing behavior. Swarm dispatch retains its separately documented
[explicit portable skill selection](../packages/swarm/README.md#working-preferences-and-portable-skills-slices-36);
this change does not claim that every external Swarm worker has the full bundle.
Do not remove a machine's global process skills until its actual worker routes
have been verified. Old sessions keep the catalog they already loaded.

## Refreshing the snapshot

Read `vendor/opinionated-skills.json`, check out its full revision in the skills
repository, and export the listed directories plus `LICENSE` with `git archive`.
Preserve the source-relative paths under `vendor/opinionated-skills/` and the
relative links from `.agents/skills` and the Claude plugin. Never snapshot an
uncommitted working tree. Update the manifest revision in the same change and
review the export for personal accounts, private material and out-of-root links.
Release assembly dereferences these links, including the worker plugin, so an
installed body needs no sibling checkout. The vendored prose is excluded from
Clankie's formatter and local-link checker (upstream examples contain placeholder
URLs); review real supporting-file references at export time.
