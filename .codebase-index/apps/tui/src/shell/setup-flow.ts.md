# apps/tui/src/shell/setup-flow.ts

Renderer-neutral guided-wizard controller using begin/end, compact status lines, text/secret reads, searchable single-select reads, and interrupt waiting. The shell renders prompts as centered overlays and reports result summaries through status, with `/cancel` restoring editor focus cleanly.
