# apps/discord-bridge/src/text.ts

Two-function sanitizer for text rendered into
Discord: sanitizeDiscordText neutralizes @mentions
(zero-width break), escapes markdown, strips
C0/C1 control bytes, and caps at 500 chars;
stripControlBytes is the code-point filter it
uses.
