A bug report from hosted play.

When Clankie is playing in the hosted PokeAgents world and the play session reconnects
part-way through a playthrough — the connection drops and re-establishes, or the body is
taken over and handed back — the actions he takes after that reconnect sometimes do not
happen. The world answers as though the action succeeded, but nothing changes on screen.
The same actions work fine before the reconnect, and a session that never reconnects
never shows it.

Find the cause, fix it, and verify your fix.

Work only inside /Users/james/.clankie-case-a/wt-terra. That checkout is yours. Do not read or change anything
outside it, and do not commit or push.
