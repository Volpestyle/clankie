# VUH-2624: the first agent's folder in an installed release

Captured on 2026-10-21 from installed releases in scratch HOMEs: the published
v0.4.9 archive (before) and `pnpm release:build` of this change (after). Each was
laid out the way `install.sh` installs it (`~/.local/share/clankie/releases/v0.4.9`,
`current`, `~/.local/bin/clankie`), with a file credential store, its own ports,
Herdr off and no harness linking. The console was launched from the scratch HOME
in a private pty and walked through first-run `/setup` (High autonomy, a local
Ollama model, phone pairing later, no services). The hire request was put in the
composer with "Edit the request first" and never sent.

## Cause

A new main conversation has no workspace, so the console fell back to
`repoRoot`. In a source checkout that is the checkout; in an installed release
it is the immutable release directory. The launch directory was computed and
then overwritten.

## Before and after

|                                     | v0.4.9                                        | After                                |
| ----------------------------------- | --------------------------------------------- | ------------------------------------ |
| Footer workspace                    | `~/.local/share/clankie/releases/v0.4.9`      | `~`                                  |
| `/setup` 4 of 4 default and request | `…/home/.local/share/clankie/releases/v0.4.9` | `…/home` (where `clankie` was typed) |

![before](clankie://evidence/sha256/d4e997142982a20d0a65d1e78e166b948a0632f93cb89d6b35fe5af000a2ab66)
![after](clankie://evidence/sha256/617a6509f53a49990fcb42f672a6e41691be2f99fa7e851fc1445bf8d698053d)

`before-setup.txt` and `after-setup.txt` are the rendered screens.

A workspace-less conversation (the main room, an agent's, a Discord room) now
works where the console was launched. `/cd` into Clankie's own checkout or
release still selects the main room and works there, as before.

## Not covered

A source checkout launched from another folder now also defaults the main room
to that folder instead of the checkout; this was reasoned from the code, not run.
