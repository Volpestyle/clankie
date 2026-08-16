# apps/tui/src/face/clankie-banner.ts

Clankie's welcome banner: the `[◉‿◉]` mascot + name,
tagline, a labelled field grid (model, harness, cwd,
server, stage, approvals), hint line, and a full-width
accent rule. Under 44 columns it collapses to one
condensed line so the header never wraps into noise.

`ClankieBannerComponent` is the pi-tui component
(setFields/setVisible/padding);
`renderClankieBanner` is the pure renderer;
`detectBannerCapabilities` probes color, truecolor,
unicode (`CLANKIE_TUI_UNICODE` override), and
columns from the stream/env, degrading truecolor →
256-color → none and unicode → ASCII (`[o_o]`).
