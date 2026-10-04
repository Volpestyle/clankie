# Bundled working skills

Clankie supplies reusable guidance for leading, reviewing, tracking work and
shipping changes. Tool and domain references can remain in the owner's global
skill selection. Skills are available context, not mandatory rituals: the task,
repository and user's authorization still govern their use.

The authoring source for reusable process skills is
[Volpestyle/skills](https://github.com/Volpestyle/skills). The pinned revision and
selected directories are in [the manifest](../vendor/opinionated-skills.json).
The snapshot retains its MIT license. The leadership merge and native delivery guidance now live upstream; the
current export needs no local patches. Clankie's own product skills remain authored in `.agents/skills`.

## Two classes, one switch

`skills.opinionated` defaults to `true`; `skills.exclude` defaults to `[]`.
Use `clankie skills` for each shipped skill's class and inclusion state,
`clankie skills opinionated off` for product/tools only, and
`clankie skills exclude NAME` / `include NAME` for individual opinionated skills.
`include` removes an exclusion; it does not turn the class on. `/skills` opens
the console picker, also reachable through `/setup`. `clankie doctor` includes
the configured selection and its catalog.

Product/tool skills are always on: `clankie`, `this-machine`, `trace-clankie`, `work-items`,
`research-team`, `computer-use-delegation`, `desktop-control`, `browser-use`, `herdr`,
and every other skill authored in this repo (including `comparison-shopping`,
`daily-digest`, `inbox-triage`, `trip-planning`, `minecraft` and `pokeagents`). Product exclusions are refused
by the CLI and ignored by loaders if present in an older settings file.

Everything selected from `vendor/opinionated-skills/` is opinionated, including
`lead`:

| Area            | Opinionated skills           |
| --------------- | ---------------------------- |
| Leadership      | lead, shared-checkout        |
| Work tracking   | linear-issues, linear-orient |
| Review          | reflect                      |
| Delivery        | c, p                         |
| Working methods | solution-space               |

The `clankie` skill teaches agents started by hand how to recognize his fleet,
reach him and report with `message_clankie` to their hiring/adopting conversation. It applies
when Clankie is named or the fleet is confirmed; discovery alone does not hire
an agent. Dotfiles can select the repo-owned source for Claude and Codex without
copying it into the personal skills repository.

The catalog contains **23 skills: 8 opinionated and 15 product/tool skills**.
VUH-1457 merged the three leadership entries into `lead`, with shared judgment,
native hires and harness delivery. Its operations reference
uses `hire_agent`, `message_seat` and `message_clankie`; Herdr holds visible terminals. The vendored dashboard plugin and board-specific references
were removed per cut audit C23. Other opinionated-skill evaluations remain on hold.

Turning guidance off does not disable leading. `herdr` remains
available as tool references. Disabled names and the merged `swarm-lead` and
`herdr-lead` names are filtered from Clankie's Pi roots and Codex worker overlays,
so an older workspace/global copy cannot restore them through those loaders.
Owner-global files are untouched.

The selection applies to new sessions and local hires. Existing sessions keep
context they already loaded: start a fresh seat, reset a service conversation,
and reopen the console to refresh its initial autocomplete catalog. A service
restart is not needed for a new selection once this code is running.

`clankie-mode` and `clankie-perf` live in the owner's skills repository and reach
Clankie through `~/.agents/skills`; the repo carries no links outside itself, which
`clankie update` refuses to stage.

## Whole-skill cuts (2026-09-28)

- `linear-write`: James's personal voice does not belong in the product.
- `update-review-ethos`: a team's MR ethos is a team decision.
- `mr-link`: GitLab-specific flow overlaps `pr-description` and `p`.
- `linear-agent-session`: mandatory session handoff ceremony is excessive.
- `repo-evolution-review`: niche historical analysis does not justify default context.
- `work-tracking`: its missing human-assignment, lead/worker authorship and bug
  triage policy is now in `work-items`; tracker selection is already there and
  in the captain instructions.

## Unbundled for near-zero use (2026-10-02)

Twelve process skills left the bundle: `blast-radius`, `co-w`, `conventions`,
`docs-review`, `herdr-handoff`, `interrogate`, `linear-grind`, `linear-plan`,
`perf-review`, `pr-description`, `robust-review` and `testing-archive`. Over 21
days of Clankie and worker transcripts each was loaded about as often as it merely
appeared in a skill listing (cut audit C22, extended). Each one cost catalog
context on every turn and duplicated James's global copy or a harness's own review
command. Upstream sources and owner-global selections are unchanged. The current
`lead` skill has no terminal or handoff-file delivery fallback; retained files
carry context and evidence through the native channel. The upstream
`herdr-handoff` skill was deleted on 2026-10-04: its kickoff typed into the
receiver's TUI, which ADR 0207 rules out for automated delivery.

`reflect` stays, with concise source-owned repairs and proposals where authority
remains open. Updating stale commands and paths under an authorized maintenance
task does not require a separate proposal ceremony. These cuts do not remove
owner-global skill selections.

Herdr is both a bundled tool skill and an independently selectable global skill.
Fresh installs and hosted bodies need its instructions without any owner-global
skills. Its source is the pinned executable's `--skill` output, not a hand-maintained
copy in the process-skill snapshot. Release assembly runs `libexec/herdr --skill`
after installing the checksum-verified pin from `scripts/release/herdr.json`, and
writes identical bytes into `.agents/skills` and both Claude plugin projections.
The hosted image also verifies all three copies and the pinned version as its
unprivileged runtime user.

In a source checkout, `pnpm herdr:skill` regenerates the checked-in skill from the
same checksum-verified pin; `pnpm herdr:skill:check` fails on drift and runs as part
of `pnpm check`. The binary is cached under `.data/herdr/bin`; a fresh checkout
downloads it from the official release. Do not edit or format the generated prose.
James's global `herdr` skill may remain for plain harnesses and should likewise
mirror the resolved `herdr --skill`. A runtime upgraded beyond the packaged pin
owns its current reference through `herdr --skill`.

## Harness discovery

- Clankie's Pi sessions, composer and TUI use `clankieSkillRoots` with the saved
  selection. Disabled bundle names are filtered from duplicate workspace/global
  roots as well; native automatic Pi discovery is disabled in favor of these
  explicit roots. Other owner skills remain available.
- A Pi turn lists only the bundled, checkout and workspace skills. Skills from
  `~/.agents/skills` and Pi's agent directory stay loaded but unlisted: the
  owner's `/name` still expands them and `skill_search` finds them by task. On
  the owner's Mac that keeps about 13k tokens of descriptions (84 skills) out of
  every machine-lane turn.
- The Claude operator seat projects the bundled plugin into a fresh private
  `skill-projections/launch-*` directory under Clankie's state home. It links the
  output style, hooks and MCP configuration, and only included skills. This is
  a launch-time variant rather than a build-time product-only copy, so arbitrary
  exclusions work too. It disables an older installed `clankie@clankie` for that
  session and enables `clankie@inline`. The development channel flag uses that
  same inline identity. `--plugin-dir` chooses the component source but still
  applies the body's skill selection. The dry-run plan includes the catalog.
- Local Claude hires receive a projected skills-only `clankie-work` plugin; it
  carries neither Clankie's identity nor operator hooks.
- Local Pi hires receive `--no-skills` plus selected explicit `--skill` paths,
  including the supported owner/workspace roots.
- Local Codex hires receive a private `CODEX_HOME` under the body's state directory
  and keep `--no-daemon`. The overlay copies configuration and hooks, preserves
  existing trust hashes for the identical hook file, and links authentication,
  plugin and transcript state. Included bundle names win over owner Codex skills;
  excluded bundle names are not linked back from that Codex home. No global
  configuration or skill links are rewritten. Shell startup must preserve the
  inherited `CODEX_HOME`. File-backed login was verified previously; Keychain-only
  login bound to the original home still needs a separate canary.

`hire_agent` accepts `skills: "bundled" | "plain"`. Omission follows the current
owner setting; `bundled` turns opinionated guidance on for that hire while still
honoring exclusions, and `plain` supplies product/tool skills only. The result's
`skills` records `mode`, `source` (setting or override), `applied`, `included` and
`excluded`. Remote or unsupported harnesses report `applied: false`; explicit
overrides there fail with `harness_unavailable`, rather than claiming an ablation.

The switch controls Clankie's supplied skills. Claude and Codex can independently
load skills through global plugins, project directories or other roots outside
this projection. Their catalogs must be inspected for a clean A/B; work outside
Clankie's checkout and use a harness environment without duplicate global process
skills. Owner-global selection remains untouched.

Release assembly dereferences exactly the current selected catalog into the
product root and both Claude projections, independent of build-machine settings.
The manifest is shipped too, so classification survives symlink dereferencing.
Re-enabling skills later needs no download. Pruned skills are absent from the
manifest, vendor export, and skill links.

## Refreshing the snapshot

Read `vendor/opinionated-skills.json`, check out its full revision in the skills
repository, and export the listed directories plus `LICENSE` with `git archive`.
Preserve the source-relative paths under `vendor/opinionated-skills/` and the
relative links from `.agents/skills` and the Claude plugin. Never snapshot an
uncommitted working tree. Reapply any recorded `localChanges` before replacing the shipped snapshot.
The current list is empty: the consolidated lead, native delivery and landing
helper fixes are all in the pinned upstream source. Update the manifest revision in the same change and
review the export for personal accounts, private material and out-of-root links.
Release assembly dereferences these links, including the worker plugin, so an
installed body needs no sibling checkout. The vendored prose is excluded from
Clankie's formatter and local-link checker (upstream examples contain placeholder
URLs); review real supporting-file references at export time.
