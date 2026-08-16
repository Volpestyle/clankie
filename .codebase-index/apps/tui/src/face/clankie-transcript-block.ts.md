# apps/tui/src/face/clankie-transcript-block.ts

`ClankieTranscriptMarkdownBlock` — the standard
transcript block: a `**Title**` first line parsed
into a tone (assistant/user/tool/reasoning/skill/
subagent/error/…), rendered as a glyph-and-color
header (`▲ Clankie`, `▌ You`, `● Tool`, `○
Reasoning`, `⨯ Error`, …) above a markdown body
indented two columns (subagent bodies get a `│ `
rail).

`parseTranscriptMarkdown` and the title matchers
recognize structured titles — `Tool: name - status`,
`Skill: …`, `Subagent …`, `Authorization`, `Input` —
and pick status glyphs (✓ / ⨯ / – / loading spinner)
from the status word. Tone inference is by title
keyword; "clanky" is still accepted as the pre-rename
assistant label in old transcripts. Caches the
markdown renderer per body text.
