# integrations/minecraft-mineflayer/src/readiness.ts

`inspectMinecraftLiveReadiness` — preflight
for the live proof, reporting the exact
remaining owner inputs without connecting:
JDK 21 present (JAVA_HOME then well-known
Homebrew/system paths, version-string
checked), the pinned Paper jar present and
matching its SHA-256 (an operator `PAPER_JAR`
override requires its own `PAPER_JAR_SHA256`),
and `MINECRAFT_EULA=TRUE` acknowledged.
Returns a strict receipt (status, checks,
missing inputs, verified jar digest) plus
non-serialized local paths for the runner's
own use.
