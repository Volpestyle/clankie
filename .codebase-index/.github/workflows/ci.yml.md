# .github/workflows/ci.yml

CI gate on pull requests and pushes to main.
Runs on macos-15 with pinned pnpm 11.11.0 and
Node 24.12.0: `pnpm install --frozen-lockfile`
then `pnpm check`. Always uploads
`artifacts/evals/self-build` as the
self-build-evaluation artifact when present.
