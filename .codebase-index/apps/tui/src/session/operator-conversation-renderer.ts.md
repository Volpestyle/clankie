# apps/tui/src/session/operator-conversation-renderer.ts

Renders the strict public conversation event union
into transcript markdown.
`renderOperatorConversationEvent` shows conversation
content and failures; healthy lifecycle plumbing
(session started/waiting/completed, turn accepted/
completed) returns `undefined` and drives the status
line instead. Operator messages always render as
"You" regardless of which surface typed them.

`operatorConversationBlockOptions` makes machinery
blocks (tool, reasoning, worker_transcript)
click-toggleable, collapsed only when the body
actually hides detail (multi-line or >160 chars).
`createOperatorConversationShellSink` adapts a shell:
suppresses the first operator message matching the
just-echoed prompt (later identical ones still
render), inserts everything else, updates the status
on turn events, and renders recovery notices.
