# apps/tui/src/index.ts

TTY-only operator-console entrypoint. It builds presence/Herdr observations and companion board, discovers model-invocable skills, resolves credentials and clients, selects/restores the server-owned operator conversation, and assembles provider, connection, Discord, memory, persona, voice, activity and core commands into `ClankieFaceShell`.

Plain prompts stream through `OperatorConversationPromptSession`; exact slash skills remain prompts for the captain, with catalog-backed completion. Status includes model, presence and context occupancy, Escape detaches observation rather than cancelling server work, and fatal handlers restore raw terminal/mouse state before exit.
