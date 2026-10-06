# Bundled skills

Clankie ships reusable guidance for leading, reviewing, tracking and shipping
work alongside his product and tool skills. Skills are available context, not
mandatory rituals: the task, repository and user's authorization still govern
their use.

## What ships

Every skill authored in [`.agents/skills`](../.agents/skills) ships with every
install and is always on. There is one class and no selection setting:
`clankie skills` (and `/skills` in the console) lists the catalog, and
`clankie doctor` includes it. Checkout-only skills live in `.agents/dev-skills`
and do not ship.

The catalog holds 19 skills: leadership and process skills (`lead`,
`shared-checkout`, `tidy`, `linear-issues`, `linear-orient`) beside product and
tool skills (`clankie`, `this-machine`, `trace-clankie`, `work-items`,
`research-team`, `desktop-control`, `herdr`, `fleet-resources`, `pokeagents`,
`minecraft`) and errands (`comparison-shopping`, `daily-digest`, `inbox-triage`,
`trip-planning`). The directory listing is the authoritative inventory.

The `lead` and `linear-issues` skills read the current effective
`fleet.closure` and `fleet.machineSetup`, including project overrides. Defaults
delegate closure and already-linked machine setup to the lead, while genuine
owner-only actions retain their boundary. See
[fleet responsibility](adr/0230-fleet-responsibility-is-owner-settings.md).

Older settings files may still carry a `skills` section (`opinionated`,
`exclude`). It is retired: the loader drops it, and every shipped skill loads.

The merged leadership names `swarm-lead` and `herdr-lead` are filtered from
Clankie's Pi roots and Codex worker overlays, so an older workspace or global
copy cannot restore them through those loaders. Owner-global files are untouched.

`clankie-mode` and `clankie-perf` live in the owner's skills repository and reach
Clankie through `~/.agents/skills`; the repo carries no links outside itself, which
`clankie update` refuses to stage.

## How harnesses receive them

- Clankie's Pi sessions, composer and TUI use `clankieSkillRoots`. Shipped
  skills win over same-named owner skills; native automatic Pi discovery is
  disabled in favor of these explicit roots.
- A Pi turn lists only the bundled, checkout and workspace skills. Skills from
  `~/.agents/skills` and Pi's agent directory stay loaded but unlisted: the
  owner's `/name` still expands them and `skill_search` finds them by task.
- The Claude operator seat projects the bundled plugin into a fresh private
  `skill-projections/launch-*` directory under Clankie's state home, linking the
  output style, hooks, MCP configuration and the shipped skills. A skill the
  owner already installs in the Claude profile's own `skills/` is left out so
  each name is listed once. The seat disables an older installed
  `clankie@clankie` for that session and enables `clankie@inline`.
- Local Claude hires load the skills-only `integrations/worker-skills` plugin;
  it carries neither Clankie's identity nor operator hooks.
- Local Pi hires receive `--no-skills` plus explicit `--skill` paths, including
  the supported owner and workspace roots.
- Local Codex hires receive a private `CODEX_HOME` under the body's state
  directory and keep `--no-daemon`. The overlay copies configuration and hooks,
  preserves existing trust hashes for the identical hook file, and links
  authentication, plugin and transcript state. Shipped names win over owner
  Codex skills. No global configuration or skill links are rewritten.
- Grok and OpenCode seats receive the shipped skill paths through their native
  per-launch configuration.

Claude and Codex can independently load skills through global plugins, project
directories or other roots outside these projections; owner-global selection
remains untouched.

Release assembly dereferences the catalog into the product root, both Claude
projections and the Codex plugin snapshot, independent of build-machine
settings, so an installed body needs no sibling checkout.

## Herdr skill

Herdr is both a bundled tool skill and an independently selectable global skill.
Fresh installs and hosted bodies need its instructions without any owner-global
skills. Its source is the pinned executable's `--skill` output, not a
hand-maintained copy. Release assembly runs `libexec/herdr --skill` after
installing the checksum-verified pin from `scripts/release/herdr.json`, and
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

## Quick-action declarations

A skill can expose a normal Clankie turn through this optional frontmatter:

```yaml
quick-action:
  name: Tidy up
  icon: broom
  selectionArg: selection
```

Clients request `includeQuickActions` on `composer_catalog` to receive these
declarations. Closed-pane roster history is available with `includeClosedPanes`
on `fleet`; omitted flags retain older strict response shapes.

The catalog validates a nonempty display name, a lowercase icon identifier, and
an optional argument name. An invalid declaration omits the action without
hiding the skill. The surface uses the existing skill invocation and can pass
selection context under the declared argument. Clankie judges and acts through
his ordinary tools; the turn stays visible and interruptible.

`tidy` is the first such skill. `/tidy` or `/tidy selection=w1:p1` starts that
skill through the console's normal conversation path. It tells Clankie to
inspect and harvest before closing, give a one-line reason, and say what he
closed. Saved reports and last output remain in roster history; Undo reopens and
resumes within five minutes. See
[ADR 0228](adr/0228-quick-actions-are-skills-and-tidy-keeps-results.md) for
native input evidence, refusal reasons and the remaining read/close race.

## History

- **2026-09-28, whole-skill cuts.** `linear-write` (personal voice),
  `update-review-ethos` (a team decision), `mr-link` (GitLab-specific, overlapped
  `p`), `linear-agent-session` (excessive handoff ceremony),
  `repo-evolution-review` (niche) and `work-tracking` (its policy moved into
  `work-items`).
- **2026-09-30, leadership merge.** VUH-1457 merged the three leadership entries
  into `lead`; the vendored dashboard plugin and board-specific references were
  removed per cut audit C23.
- **2026-10-02, unbundled for near-zero use.** `blast-radius`, `co-w`,
  `conventions`, `docs-review`, `herdr-handoff`, `interrogate`, `linear-grind`,
  `linear-plan`, `perf-review`, `pr-description`, `robust-review` and
  `testing-archive` left the bundle: over 21 days each was loaded about as often
  as it merely appeared in a listing (cut audit C22). Owner-global selections
  were unchanged. The upstream `herdr-handoff` skill was deleted on 2026-10-04:
  its kickoff typed into the receiver's TUI, which ADR 0207 rules out.
- **2026-10-06, one class.** The process skills previously vendored from
  Volpestyle/skills became repo-owned skills in `.agents/skills`; the
  `skills.opinionated`/`skills.exclude` settings, the `clankie skills`
  selection subcommands and `hire_agent`'s `skills` override were removed.
- **2026-10-06, usage cut** (21-day usage audit;
  [ADR 0236](adr/0236-clankie-owns-the-skills-he-ships.md)).
  Unbundled; the owner keeps global copies, and the retired-name filter does
  not cover these names, so those copies stay loadable:
  - `reflect`: 54 load sessions, only 1 from the bundled copy.
  - `c`: 51 worker sessions, 1 from Clankie, 1 owner-typed `/c`.
  - `p`: 34 worker sessions, none from Clankie.
  - `solution-space`: 38 worker sessions, 1 from Clankie.

  Folded: `computer-use-delegation` (3 loads in 383 listings, none from Clankie)
  into `desktop-control`'s delegation reference, and `browser-use` (4 loads in
  320 listings) into `this-machine`'s browser reference.
