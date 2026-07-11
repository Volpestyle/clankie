# Local runner

The runner is the trust boundary that owns worktrees, worker processes, PTYs, provider-native sessions, credentials, network restrictions, and control leases. It connects outbound to the control plane or relay.

The skeleton contains a non-PTY shell adapter and the interfaces needed for native PTY, Herdr, tmux, Codex App Server, Claude Agent SDK, and Pi RPC adapters. Do not put merge, deployment, or organization-wide connector tokens inside worker environments.
