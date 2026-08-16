# apps/tui/src/skill-catalog.ts

Discovers model-invocable `SKILL.md` files from project and user skill roots for slash completion in the operator console. The walker follows links safely, deduplicates visited files/directories, parses skill metadata, and hides skills that disable model invocation.

`clankieSlashSkillSuffix()` and `resolveClankieSlashSkill()` implement append-only completion and exact `/skill` resolution.
