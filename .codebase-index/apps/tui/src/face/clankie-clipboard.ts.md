# apps/tui/src/face/clankie-clipboard.ts

Clipboard writing for drag-select copy.
`writeClankieClipboard` emits the OSC 52 sequence
(wrapped in tmux/screen passthrough when needed) so
copy works over SSH, and also pipes to the platform's
native binary (pbcopy / clip / wl-copy / xclip) for
local terminals that ignore OSC 52. All failures are
silently swallowed — copying is best-effort.
