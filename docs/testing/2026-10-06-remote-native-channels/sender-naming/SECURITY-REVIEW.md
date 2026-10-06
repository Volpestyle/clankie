# Native security review

Reviewer: native Codex subagent `/root/receipt_security`, 2026-10-06.

Both source fixes approved separately; no security blockers.

1. Fresh-root naming is limited to a service-registered remote launch with no resume and no existing nonempty native name. It awaits the native naming acknowledgment and exact ID/name read before returning the controller or sending a brief. All original binding, complete single-thread inventory, socket and lifetime checks remain.
2. The catalog ownership flag accepts only the constant `1` for a private remote launch. It is removed before the Herdr-only environment filter and assigned as a constant in this created server's environment. Other values, legacy remote launches and arbitrary environment changes still reject. It only suppresses duplicate hook catalog reporting; native catalog/readiness gates remain.

The proposed helper-thread exception was rejected: thread source is analytics metadata, and a disabled Clankie MCP alone does not prove that other execution surfaces are disabled. No helper exception was implemented.

The reviewer ran no checks. Real TUI name-event ordering, empty-root persistence and report/peer acceptance require deployed PC proof.
