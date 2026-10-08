# Operator-seat owner mail publication

Work: [VUH-1843](https://linear.app/vuhlp/issue/VUH-1843).

The lane adapter supplied the constant `lane-mail_owner_update` as the authored
tool execution ID. The mailbox correctly refused a different draft under that
already-persisted identity. The collision affected successive calls as well as
bridge restarts.

Each logical bridge mail call now gets a UUID before transport execution. An
explicit pre-admission session replay retains it. The lane endpoint forwards
the UUID into the authored tool and returns it in MCP metadata:
`_meta["clankie/owner-update"].publicationId`. An exact retry sends the original
metadata and draft; a changed draft under that UUID still refuses. Distinct
calls with identical content remain distinct. Older/direct callers without
metadata get a fresh host identity. The source conversation and authority
continue to come from the host; publication identity grants no access.

## Integration evidence

`apps/clankie/test/owner-update-bridge.integration.test.ts` uses real stdio
bridge child processes, official MCP clients, loopback HTTP, the production
captain/lane bank and persistent mailbox. It starts no model or hired worker.

It proves:

- Distinct calls with identical drafts produce distinct updates.
- An exact identity/draft retry returns the original update, including after
  restarting both service and bridge.
- Changed content and malformed publication metadata refuse without new mail.
- An old HTTP session receives an explicit 404; the bridge reconnects and
  replays the unadmitted call with the same UUID.
- A result lost after publication causes no automatic retry. An explicit retry
  with the original identity after bridge restart finds the one original.
- Legacy callers get distinct host identities. All updates retain their source
  conversation and unread state.

The focused four-file gate passed all 49 tests (this regression, owner-update
persistence, lane MCP and seat bridge coverage). Logs are retained locally in
`.local/evidence/vuh-1843/` in the worker's checkout.

The landing gate passed all 30 typecheck tasks and 6,186 tests across 655 test
files, plus formatting, lint, static and documentation checks.

## Owner activation

The worker has not restarted the live service or modified existing mail.
Deploy the landed service and reconnect the operator bridge with `/mcp` for the
new transport behavior. Then deliberately publish a new update and inspect
the owner mailbox. The live post-deploy check remains an owner step.
