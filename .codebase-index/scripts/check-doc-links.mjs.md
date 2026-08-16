# scripts/check-doc-links.mjs

Repository documentation-link validator used by `pnpm docs:check`. It scans tracked Markdown, resolves relative links and anchors, skips generated/vendor areas and external URLs, and reports broken references so current guides and historical ADRs remain navigable after pruning.
