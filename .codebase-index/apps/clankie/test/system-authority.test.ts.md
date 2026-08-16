# apps/clankie/test/system-authority.test.ts

Tests the Discord system-tool authority boundary. Only allowlisted actors on text turns receive the grant; empty allowlists, voice turns, and non-Discord/operator cases fail closed.
