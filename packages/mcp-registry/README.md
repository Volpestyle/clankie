# @clankie/mcp-registry

Operator-authored registry of MCP servers and the doctrine projection that decides which of their tools workers may execute directly.

## Model

- The registry file (YAML, `McpRegistrySchema`) is trusted runner configuration. Models never author or mutate it.
- Every declared tool carries exactly one connector risk class (`read`, `reversible-write`, `irreversible-write`, `publish-external`, `destructive`). `narrative-write` is excluded: that class is a closed whitelist owned by the tracker and Discord presence planes.
- `projectMcpToolGrants` registers each tool as the doctrine action `mcp.<server>.<tool>` and evaluates it through `decideAction`. Only an exact `allow` projects the tool into a worker: a worker cannot pause mid-tool for a human, so `require_approval` and `deny` both withhold it. Approval-gated actions belong on the privileged connector path, never in worker tool sets.
- `projectMcpWorkerServers` shapes grants per harness. Tool granularity (Claude) injects a server when at least one tool is allowed and enforces the per-tool allowlist; server granularity (Codex) injects a server only when every declared tool is allowed, because that harness cannot filter individual MCP tools.

## Security invariants

- Undeclared tools are never projected; the doctrine rule that unclassified unknown actions are denied is preserved end to end.
- Server processes receive only `staticEnvironment` plus the `credentialEnvironment` allowlist resolved from the runner host. They never inherit the runner environment wholesale. A server whose credentials are unavailable is withheld, not started degraded.
- MCP server processes are connector adapters launched by the worker harness on the runner host; they are not confined by the worker tool sandbox. Register only servers you would trust as connectors, and scope their credentials accordingly.

## Usage

The runner loads the registry from `CLANKIE_MCP_REGISTRY`, projects it through the compiled doctrine profile, and passes per-harness server lists into worker adapter options. See `apps/runner/src/provider-factory.ts` and `doctrine/mcp-registry.example.yaml`.

The package also projects the provider-native web research actions (`web.search`, `web.fetch`, both read-class): `projectWebToolGrants` decides whether the Claude worker may use its built-in WebSearch/WebFetch tools on research tasks.
