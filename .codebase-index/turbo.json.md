# turbo.json

Turborepo pipeline for the monorepo, using the
turbo TUI. Five tasks: `build` and `typecheck`
depend on upstream packages' same task
(`^build` / `^typecheck`) with no cached outputs,
`test` is standalone, `dev` is persistent and
uncached, `clean` is uncached. No outputs are
declared anywhere — turbo is used purely for
ordering and parallelism, not artifact caching.
