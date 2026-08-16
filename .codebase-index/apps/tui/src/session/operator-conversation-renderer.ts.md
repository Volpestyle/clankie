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
`createOperatorConversationShellSink` adapts a shell: it suppresses the first operator message matching the just-echoed prompt, records the block handle returned for each started tool call, and rewrites that same block on completion/failure with the original arguments plus result. Terminal events with no observed start still insert normally; turn events update status and recovery notices remain visible.
