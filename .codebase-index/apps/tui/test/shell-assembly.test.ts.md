# apps/tui/test/shell-assembly.test.ts

Constructs `ClankieFaceShell` without starting it
(start() needs a TTY) and asserts the wiring: setup
flow idle, default layout, spinner resolved, and the
console command set carrying names and descriptions.
