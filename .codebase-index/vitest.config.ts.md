# vitest.config.ts

Single vitest config for the whole repo. If cwd
is a workspace package (apps/x, packages/x,
integrations/x) it scopes the run to that
package's test/**/*.test.ts; from the repo root
it runs every package's tests.

Runs strictly serially — fileParallelism off,
maxWorkers 1, threads pool — because tests share
ports, sockets, and on-disk state. 30s test and
hook timeouts. Excludes node_modules, .turbo,
dist, and artifacts.
