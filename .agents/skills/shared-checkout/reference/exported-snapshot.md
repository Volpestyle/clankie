# Checking an exported snapshot

Detail for [shared-checkout](../SKILL.md).

When checking an exported source snapshot with already-installed pnpm 11
dependencies, use `pnpm_config_verify_deps_before_run=false pnpm check`.
The default preflight can launch an install even for a check command and
rewrite dependency links. Keep the sibling-directory layout declared by
`pnpm-workspace.yaml`; linked dependencies alone do not satisfy workspace checks.
Make each sibling a real directory, never a symlink: pnpm links through a
symlinked sibling but does not register it as an importer, so a lockfile
generated there omits its dependencies and a frozen install passes in the
scratch copy but fails in a real checkout or CI.
Pin linked workspace sources too: a clean app export can still bundle dirty
sibling code through dependency links. For JavaScript bundles, compare source-map
contents against each workspace's committed revision, not just the app's.
