# apps/clankie/src/tldraw-host.ts

Clankie's drawing port to the local tldraw desktop app. `createTldrawHost()` creates or reuses a board, installs the `tldraw-design-systems` script plus fixed ER/sequence builders, passes diagram requests as data rather than executable code, and exports bounded PNG artifacts.

The host reads the app's per-launch port/token, verifies script application and live builder registration, retries oversized exports at lower scale, and returns sayable refusals when the canvas or design system is unavailable. `tldrawEnabled()` controls the optional capability.
