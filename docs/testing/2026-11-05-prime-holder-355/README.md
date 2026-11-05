# Prime worker resource identity

The startup scrub from #816 is already on main. This proof adds coverage for
a prepared Prime seat without changing production authority or restart policy.

Prime Agent 0.10.0 runs its real daemon, worker and native TUI in private
HOME, XDG, state and socket roots. The TUI is in an isolated Herdr namespace.
No brief, model request, sign-in or live daemon is used.

Run with the verified native binary:

```sh
PRIME_RESOURCE_TEST_EXECUTABLE=/absolute/path/to/prime-agent \
  clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/prime-resource-holder.integration.test.ts \
  apps/clankie/test/prime-hired-holder.integration.test.ts \
  apps/clankie/test/prepared-host-herdr-golden.integration.test.ts
```

The native run passed all six cases with no skips. It observes:

- All seven inherited service/session identity fields are empty.
- A worker shell's heavy permit belongs to that executing native PID, in the
  Prime worker's process group, with no inherited holder label.
- The bound native host admits that worker ancestry and refuses the supervisor.
- Losing the worker or its watched pane makes the native host refuse.
- In private copies of the resource module, an absent or unreadable identity
  response for the executing command refuses a heavy acquire even with copied
  operator labels. No command runs and no permit or queue entry is created.

The normal path uses real kernel observations. The last two identity-read
failures are controlled faults in private observer copies; other reads retain
the real observer. The test leaves production sources unchanged. Its empty MCP
fixture prevents accidental contact with a live service; this is a prepared-seat,
native-host and resource-governor proof, not a live MCP/HTTP admission or actual
close-adapter proof. The three golden cases separately check prepared-host
protocol handling and do not run Prime.

An already-running daemon that inherited an old identity still needs its owner
to restart it. This test neither changes that policy nor restarts the owner's
daemon. The test's own supervisor is stopped only while its native birth still
matches the one recorded at launch.
