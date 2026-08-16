# packages/discord-presence-core/test/addresses-character.test.ts

Text-plane name matching: recognizes "hey
clankie", "Clanky", "clankie?", "@Clankie";
never fires on a name inside a longer word
("clankiest", a URL); quiet for ordinary
conversation and with no names configured. Also
`parseDiscordReplyPolicy` defaults absent or
unknown values to agent-first `all`; only exact
`addressed` selects the cost-saving gate.
