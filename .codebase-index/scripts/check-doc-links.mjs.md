# scripts/check-doc-links.mjs

Doc-link checker run as `pnpm docs:check` (part
of `pnpm check`). Walks the whole repo (skipping
node_modules, .git, .turbo, artifacts), scans
every .md file for `[text](target)` links, and
verifies each relative target exists on disk.

http(s), mailto, and pure-#anchor links are
skipped; fragment suffixes are stripped and
targets are URL-decoded before the existence
check. Prints all broken links and exits nonzero
if any are found. Anchor validity within a file
is not checked — only path existence.
