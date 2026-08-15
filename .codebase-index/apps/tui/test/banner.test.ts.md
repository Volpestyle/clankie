# apps/tui/test/banner.test.ts

Banner rendering across capabilities: full layout vs
the condensed narrow form, field rows, unicode/ASCII
mascot fallback, color degradation, width fitting,
and `detectBannerCapabilities` env handling
(NO_COLOR, TERM=dumb, COLORTERM, unicode overrides).
