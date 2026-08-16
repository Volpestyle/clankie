# docs/adr/0055-launcher-owned-local-services.md

Decision that the `clankie` launcher owns startup, health gating, restart order, shutdown, PID verification, and logs for local service processes. Operators use target-aware launcher commands instead of hand-rolled process control.
