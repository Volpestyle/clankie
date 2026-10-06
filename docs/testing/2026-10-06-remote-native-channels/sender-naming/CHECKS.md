# Fresh remote root naming and catalog ownership

The owned PC probe found Codex 0.160.1's title helper beside the original hired thread; see [native evidence](native-title-helper.json). A second loaded thread or different-thread notification correctly revokes the original registration, but an unnamed managed TUI starts a title helper when it receives its initial user input.

Fresh managed remote roots now receive their assigned Herdr name through `thread/name/set`, followed by an exact native `thread/read`, before any brief. Resumes and existing names are preserved. Naming failure stops startup without sending a brief. Strict single-thread checks remain; no tag is granted authority. [Codex 0.160.1's native title gate](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/app/thread_routing.rs) checks whether the thread already has a name.

The dedicated PC server also receives the controller's catalog-observation flag in its own launch environment. Its SessionStart hook avoids reporting an unsupported embedded catalog over the controller's original-thread native evidence. Account config and the remote environment allowlist are preserved.

Verification: 70 focused tests in four files passed; Clankie typecheck, scoped lint and diff checks passed. Heavy steps used the fleet limiter. Tests cross the real WebSocket RPC boundary, assert naming before the first turn, preserve existing names, and prove that native rejection sends no turn. Kernel/socket goldens are not live authority. [Native security review](SECURITY-REVIEW.md) approved both fixes.

Live acceptance stays pending deployment. This source check does not close VUH-1527.
