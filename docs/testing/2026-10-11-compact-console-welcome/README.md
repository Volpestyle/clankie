# Compact console welcome (VUH-2151)

[Issue](https://linear.app/vuhlp/issue/VUH-2151).

The fresh-conversation welcome now draws Clankie in seven rows and eleven
columns, down from fourteen rows and twenty-two columns. The pet's first idle
frame remains the source: each 2×2 group becomes one silhouette pixel, screen
pixels become holes while its frame and two eyes stay solid, and two silhouette
rows share a terminal cell. No second
figure or Prime Agent art is maintained. The figure inherits the terminal's
foreground; only the theme-green leaves and muted text add colour. No background
colour is painted by the welcome. ASCII, no-colour and condensed fallbacks stay
available.

Prime Agent 0.10.0 was launched live in an owned Herdr pane. Its welcome used
seven rows of block characters, mostly terminal foreground, beside restrained
metadata. Only scale, glyph style and colour restraint informed this change;
none of its code or art was used. Its private reference read is retained locally,
not republished here.

## Captures

The VUH-2022 preview script starts the real `ClankieFaceShell` with an empty
conversation and fixed footer metadata. Before uses the source at
`990a774a4cceaba7a5b3f6d2939d5529a70b8041`; after uses this change. Both run in
owned Herdr pane `w48:p8`, through `clankie heavy --server --`, with `stty cols`
set to 80 or 170 and `stty rows` to 40. Screens were read with
`herdr pane read --format ansi`. The locally retained `.ansi` files are those reads.

VHS replays each read in Builtin Dark and Builtin Light with Menlo at 16px.
Only trailing Herdr viewport spaces and blank rows beyond the console's forty
rows are removed in the replay. The replay viewport has enough pixel width to
preserve the captured columns without introducing additional wrapping. These are terminal-screen replays, not desktop
screenshots. The title, artwork, both help lines, caret and footer are retained.
The light/dark variants use identical console output; the figure therefore
follows the terminal's own foreground without a palette change.

| Width      | Before                 | After                    |
| ---------- | ---------------------- | ------------------------ |
| 80, dark   | `before-80-dark.png`   | `after-v2-80-dark.png`   |
| 80, light  | `before-80-light.png`  | `after-v2-80-light.png`  |
| 170, dark  | `before-170-dark.png`  | `after-v2-170-dark.png`  |
| 170, light | `before-170-light.png` | `after-v2-170-light.png` |

## Verification

- Real shell inspected at 80 and 170 columns: seven art rows, complete help
  text, no wrapping, input caret and footer present.
- Existing `apps/tui/test/banner.test.ts`: eight tests pass.
- Direct renderer acceptance checks pass at 80 and 170 columns for no colour,
  256 colour and truecolour: seven rows, full help text, every row within the
  requested width, at most two foreground styles, no painted backgrounds.
- Explicit touched-file formatting and lint pass under `clankie heavy`.

Media receipts are in `evidence.json`. The integrator supplies the landing gate;
focused checks here do not substitute for it.

The first draft (`after-80-*`, `after-170-*`) is retained in the evidence store
as a reviewed intermediate. Clankie requested a hollow screen frame instead
of a filled head, separate leaf blobs on a short stem, and green leaves with
the rest in terminal foreground. The `after-v2-*` captures show that revision.
