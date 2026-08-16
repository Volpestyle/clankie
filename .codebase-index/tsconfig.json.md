# tsconfig.json

Root noEmit TypeScript project: extends
tsconfig.base.json, restricts lib to ES2023 and
types to node, and includes app/integration/
package sources for whole-repo tooling. Real
typechecking runs per-package via turbo — each
workspace package has its own tsconfig.

Note: the apps/* include list is stale — it names
pre-rewrite apps (captain-eve, control-plane,
devtools, lead-agent-lab, runner) alongside
surviving ones, and omits apps/clankie and
others. Globs that match nothing are harmless,
but this file does not reflect the current app
set; the per-package tsconfigs do.
