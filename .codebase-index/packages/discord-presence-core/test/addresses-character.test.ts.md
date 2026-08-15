# packages/discord-presence-core/test/addresses-character.test.ts

Text-plane name matching: recognizes "hey
clankie", "Clanky", "clankie?", "@Clankie";
never fires on a name inside a longer word
("clankiest", a URL); quiet for ordinary
conversation and with no names configured. Also
`parseDiscordReplyPolicy` falling back to the
quiet `addressed` policy for absent/unknown
values (only exact "all" is noisy).
