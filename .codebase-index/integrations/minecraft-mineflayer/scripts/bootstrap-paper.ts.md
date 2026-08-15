# integrations/minecraft-mineflayer/scripts/bootstrap-paper.ts

`minecraft:paper:bootstrap` — downloads Paper
1.21.11-132 from PaperMC's immutable object
URL into the cache directory, verifying the
final URL, declared content-length, byte size,
and SHA-256 before an atomic tmp-write +
hard-link install (races resolve by
re-verifying the existing target). Rejects
symlinked cache paths. Prints a JSON receipt;
it explicitly does not accept the EULA.
