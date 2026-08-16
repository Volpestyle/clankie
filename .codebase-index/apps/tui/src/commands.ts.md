# apps/tui/src/commands.ts

`buildConsoleCommands(context)` builds core `FaceShellCommand`s: help, conversation selection, lane trace, layout/header/spinner controls, activity/status, Herdr `/board`, clear, and exit. Results render as `done /cmd command` transcript blocks.

Dependencies remain optional so the face can start before credentials/services; unavailable ports report explicitly. `/board` opens or focuses the labelled Herd Lead companion, while `/status` combines presence, selected conversation, activity and Herdr roster.
