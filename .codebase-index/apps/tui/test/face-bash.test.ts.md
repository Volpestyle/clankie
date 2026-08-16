# apps/tui/test/face-bash.test.ts

The inline `!` escape smoke, ported from v1:
`runFaceBashCommand` stdout/stderr capture, exit
codes, output cap, timeout (exit 124), spawn errors
(127), and cancellation signal mapping; plus the
result renderer's header/output/footer. Spawns only
trivial portable commands (printf, exit, sleep).
