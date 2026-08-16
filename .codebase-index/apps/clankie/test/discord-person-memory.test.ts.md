# apps/clankie/test/discord-person-memory.test.ts

Discord person-memory routes over file memory:
an authenticated proposal applies directly (no
approval ceremony anymore), recall by stable
guild/user id with a query card, facts survive a
restart of the store, operator-only export and
delete (ambient export 401s),
operator_private facts stay out of ambient reads
but inside the export, and non-Discord captain
identities are refused (403) for proposal and
recall.
