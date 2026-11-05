# Input-line captures

The `pi-empty.ansi`, `grok-empty.ansi` and `opencode-empty.ansi` files were
captured on macOS from Pi 1.3.0, Grok Build 1.0.70 and OpenCode 1.18.35.
Each native TUI started without an initial prompt in an isolated HOME/XDG and
cwd under a private Herdr server. Network access was blocked, credentials were
dummy strings, and no model turn ran. Only workspace creation with `--no-focus`,
pane listing and `pane read --source visible --format ansi` were used. No keys,
input, focus, scrolling or owner panes were involved. Servers were stopped
after capture.

Unrelated startup art was cropped; temporary cwd paths were replaced with
`/tmp/fixture/...`. Native composer cells, SGR styles and padding are retained.
The Grok fixture has no ghost text. Pi's editor is blank. OpenCode shows its
native dim `Ask anything…` placeholder.

The integration test's draft, leader-key, clipped-frame and malformed cases
are explicitly derived mutations of these captures, not additional live-pane
captures. OpenCode 1.18.35's own renderer uses the muted colour for both typed
input and the model label during leader-key mode; that case must never prove
empty. A typed copy of its placeholder uses normal input styling.

The test also replays the captured empty frames through a real isolated
Herdr server, its terminal cell formatter, and Clankie's `readPane` runner.
The fixture program only writes its initial display to stdout. It receives no
pane input. No harness or model is launched by the committed tests.

The older Claude/Codex captures predate this extension and are preserved.
