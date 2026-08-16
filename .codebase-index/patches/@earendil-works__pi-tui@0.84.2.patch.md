# patches/@earendil-works__pi-tui@0.84.2.patch

pnpm patch for `@earendil-works/pi-tui@0.84.2`
that adds editor ghost text. `EditorTheme` gains
an optional `ghostText` style and `Editor` gains
`setGhostText`; the suffix renders at an end-of-line
cursor, accepts with Tab, and clears on cursor
movement or submit.

The patch updates both the distributed JavaScript
and declaration file because pnpm applies it to
the published package contents.
