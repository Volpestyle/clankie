# PC Claude cache delivery (VUH-1745)

Read-only inspection on 2026-10-08 found the fixed worker in the PC marketplace,
but both native Claude user profiles still loaded the old worker cache. The
marketplace and installed caches all declared version `0.6.7`. Native plugin
update uses that version to select cached files; shipping changed helpers under
the same version did not deliver the earlier repair.

The transport and warning fixes already landed in `20038e9a` and `ead3ffd3`.
This follow-up gives both worker manifests version `0.6.8` so native preparation
can deliver those fixes. It does not change PC configuration or refresh an
already-running Claude process.

## Observed files

The PC fleet is `pc`, host `supedupsilly`. Both `.claude` and `.claude-james`
user installations pointed to `plugins/cache/clankie/clankie-worker/0.6.7`.
Their installation timestamps were respectively `2026-10-06T09:39:51.518Z`
and `2026-10-06T09:40:07.307Z`. The alias also had a project installation at
`0.6.1`; a native acceptance run must record the plugin actually selected in
its checkout, rather than assume the user installation wins.

| File                    | Installed user cache SHA-256                                       | Marketplace/current source SHA-256                                 |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `mods/tool-catalog.mjs` | `3bd13d4b334d21fab5c5ed91677924190c0b98cdac57c66af10484f51051d960` | `341405b98f4d1a2e2a8e074864ab0a78cf221a326f4730608a9f2edbe70ebbfa` |
| `mods/report.mjs`       | `c79064b379723d92c0dad36d2201729497c38910a7a306212731c64c1a72c2cb` | `5bc5dd688014e4ef6f48369547bfac17d73f5ef2422dc6061fbe3406825324f8` |

The installed bytes exactly match the parent of `20038e9a`. They retain the
generic warning, reset warning history after a healthy report, and use the
shorter HTTP deadline. The marketplace matches current source, including
typed refusals, one warning per cause and idle retries. The
[earlier transport investigation](../2026-10-06-pc-claude-tool-check/README.md)
explains the failure mechanism and its limits: the initiating historical
caller remains unknown. This inspection proves a delivery mismatch; it does
not infer an authentication failure from the generic warning.

## Native cache reproduction

The opt-in test at
`apps/tui/test/claude-plugin-version-cache.integration.test.ts` runs the real
Claude plugin manager against an owned temporary local marketplace and
isolated profile. It installs old bytes, changes the source without changing
the version, updates, then updates again with the shipped worker version.
It makes no model calls, uses no existing profile or credentials and removes
only its own temporary files. Run it manually through the fleet resource gate:

```sh
clankie heavy -- env NATIVE_CLAUDE_CACHE_FIXTURES=1 pnpm exec vitest run --config vitest.config.ts apps/tui/test/claude-plugin-version-cache.integration.test.ts
```

Before the version bump, native Claude `2.1.293` on macOS retained the old bytes
after both updates; [the baseline test failed](cache-baseline.txt) at the
expected new-content assertion.
The PC native CLI observed read-only was `2.1.294`. The isolated Mac test proves
the plugin-manager cache boundary, not native PC pane reporting.

With shipped version `0.6.8`, the same native test delivered the changed bytes
to a new cache path. It and the harness profile checks passed
[10 tests with no skips](cache-fixed.txt).

The five existing relay, remote proof, catalog health, fleet-link and Claude
mod/helper test files passed [134 tests](source-focused.txt). They preserve
proof refusals and exercise typed warnings, deduplication and idle recovery.
The mod engine in the helper tests is an explicit surrogate; their real HTTP
boundary does not substitute for native PC pane acceptance.

`clankie heavy -- pnpm check:landing` passed formatting, lint, deadcode,
documentation checks, all 29 typechecks and 9 changed tests. Its one skipped
test is the opt-in native cache fixture, which passed separately above.
The [landing summary](landing-summary.txt) retains the final gate results.

## Live acceptance after deploy

Deploy and prepare the PC through the approved setup path. Before changing PC
configuration or hiring there, tell the owner. Check both user caches have the
new worker version and fixed helper bytes. Installation evidence does not
prove that an existing process has replaced its imported mod.

Use one owned native PC Claude pane with an authenticated profile and a
checkout that does not select the legacy project plugin. Retain its hire,
pane, session and actual plugin-root evidence. Exercise a Clankie tool and
observe successful catalog reporting over at least two turns. Then exercise
a repeated refusal through an isolated owned link, without disrupting the
shared fleet relay: confirm one actionable warning per cause, healthy idle
recovery and preserved same-session native tools. Clean up only the owned
pane. Coordinate refresh of other leads' processes separately (VUH-1742).

That native PC pane proof remains an acceptance gap. No PC workers were
hired, no PC configuration changed, and no live service was restarted or
deployed by this work.
