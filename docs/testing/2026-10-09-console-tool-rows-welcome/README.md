# Console tool rows, welcome and caret (VUH-2022)

[Issue](https://linear.app/vuhlp/issue/VUH-2022).

The operator console (`apps/tui`) now follows Prime Agent's transcript: one row
per tool call that highlights on hover and opens individually, an ASCII-art
welcome on a fresh conversation, and a caret at the start of the input line.
Prime Agent 0.10.0 was studied live in a Herdr pane; none of its code or art
was used. The welcome draws Clankie's leaf sprout from the desktop pet's idle
frame (`branding/pet/src/pet/idle.txt`).

## How the captures were made

[`console-preview.ts.txt`](console-preview.ts.txt) starts the real
`ClankieFaceShell` in a 174×53 Herdr pane with a fixed transcript: a user
message, five tool calls (grep, read, a failed read, bash, a Linear MCP tool)
and a reply. Hover and click were real SGR mouse reports sent to the pane;
`Alt+↑`, Enter, Escape and `Ctrl+O` were real key presses. Each screen was read
back with `herdr pane read --format ansi` and rendered with `vhs`.
"Before" ran the same script against the shell at `a3523f2d1`.

| Screen                             | Before                  | After                       |
| ---------------------------------- | ----------------------- | --------------------------- |
| Fresh conversation                 | `before-fresh.png`      | `after-fresh.png`           |
| Transcript                         | `before-transcript.png` | `after-transcript.png`      |
| Hovered row                        |                         | `after-hover.png`           |
| Clicked row, opened in place       |                         | `after-click.png`           |
| `Alt+↑` twice selects the bash row |                         | `after-keyboard-select.png` |
| Enter opens the selected row       |                         | `after-keyboard-open.png`   |

The media links are in [`evidence.json`](evidence.json).

## What was checked live

- Hover highlights only the row under the pointer and clears when the pointer
  leaves; the row shows `click to open` or `click to close`.
- Clicking opens Pi's own tool component beneath the row and keeps the row's
  header on screen. Clicking it again closes it.
- `Alt+↑` selects the newest row, then older ones. Enter toggles the selected
  row, Escape clears the selection, and typing clears it and reaches the prompt.
- `Ctrl+O` still opens every row at once.
- A failed call keeps its first error line visible while closed.

Two defects found while capturing were fixed before landing. Opening a row from
the input observer moved content before pi read the same mouse release, which
pi treated as a text selection (`Copied!`); the toggle now runs after pi
handles the click. Pi's built-in tools (`read`, `bash`, ...) had always fallen
back to raw JSON arguments because the shell never passed pi's definitions;
it now does, without pi's bash timer, which would read `Took 0.0s` on replayed
history.

## Not covered

- Hover depends on all-motion mouse reporting, which pi turns off under tmux and
  screen; the keyboard path covers those terminals.
- The console bundles one lead look. It reads `appearance.leadSkin` at startup,
  and any id it does not bundle draws the default sprout, as ADR 0248 specifies
  for clients.
- The app half (condensed tool summaries with an inspect drawer) is out of scope.
