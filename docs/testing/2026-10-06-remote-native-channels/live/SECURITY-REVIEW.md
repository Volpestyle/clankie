# Native security review: scoped remote Codex catalog metadata

Reviewer: native subagent `/root/receipt_security`, 2026-10-06. Read-only review
of the delta on `f6260751`; no tests or heavy commands run by the reviewer.

Approved with no security blocker. The launcher removes
`CLANKIE_EXPECTED_TOOL_NAMES` from a copied launch environment only when an exact
`-c mcp_servers.clankie.env.CLANKIE_EXPECTED_TOOL_NAMES=...` value matches.
Missing or mismatched metadata remains unsupported and fails before SSH.
`CODEX_HOME` and other arbitrary environment variables still fail, including
alongside matching metadata. The Windows private launcher continues using the
remote machine's own environment/accounts and independently pins the bridge and
process lifetime. Expected tool names deny readiness; they grant no tools.
Authenticated catalog and expected-tools binding checks remain in place.

The existing boundary tests were extended after review to cover missing and
mismatched metadata and an account override alongside matching metadata.
