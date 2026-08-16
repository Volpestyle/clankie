# .github/workflows/ci.yml

CI gate on pull requests and pushes to main.
Runs on macOS 15 with pinned pnpm 11.11.0, Node 24.12.0, and Rust 1.85 with Clippy/rustfmt; installs CMake, performs a frozen install and `pnpm check`, then builds the release `@clankie/vox` binary. Always uploads
`artifacts/evals/self-build` as the
self-build-evaluation artifact when present.
