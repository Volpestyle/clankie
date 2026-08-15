# apps/discord-bridge/test/readiness.test.ts

Text readiness over an in-memory credential store
and faked REST: a fully configured official-bot
composition reports ready with no secret, bot
name, or username leaking into the report JSON;
missing prerequisites produce a fail-closed
report with actionable detail per check.
