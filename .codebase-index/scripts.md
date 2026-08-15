# scripts

Three standalone Node .mjs utilities behind root
package.json scripts — repo hygiene and developer
setup, no build step, no dependencies beyond
node: builtins.

- check-doc-links.mjs — `pnpm docs:check`; fails
  the check gate on broken relative markdown
  links.
- doctor.mjs — `pnpm doctor`; PASS/FAIL/SKIP
  report on toolchain, credential-broker, and
  launcher status.
- install-cli.mjs — `pnpm cli:install`; symlinks
  the `clankie` launcher into ~/.local/bin.

check-doc-links runs inside `pnpm check`; the
other two are one-time / on-demand setup aids
referenced from the README quickstart.
