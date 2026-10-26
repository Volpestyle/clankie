# VUH-2830: deferred Linear CLI tools

Source candidate based on `a4759c62229d6cfffde19613d2f41efd9d546c79`.
This is source integration evidence, not installed acceptance. No live status
update was posted, grants changed, or runtime restarted.

## Observed failure and cause

The installed CLI returned `No tool named linear_graphql in this lane.` and
the equivalent refusal for `linear_get_status_updates`. The same context's
doctor reported `linearGraphql.usable: true` from credentials alone.
The full doctor receipt remains in `.local/vuh-2830/installed-doctor.json`;
the uploaded excerpt includes only the relevant fields.

`buildLaneToolBank` exposes only initial connected tools directly. Both named
operations are deferred. The CLI's direct invocation failed in `/v1/mcp`
before the host or Linear API handler. The repair uses the existing
`mcp_tool_call` directory, preserving host and project authorization.
Doctor checks its local credential audience and the same operator catalog;
its explicit scope does not claim a successful provider query.

## Proof and limits

`route-proof.log` retains actual responses through `runLinearCommand` with
fixture environment authentication → TCP `/v1/mcp` → real lane bank → real
MCP host/API tracker → schema-validating local Linear HTTP fixture. The
fixture also retains the original direct-call failures before the repaired
CLI invocation, with no provider dispatch. A stub supplies the bank without
a model; no live Linear credential participates in that proof.

- Actual doctor and CLI agree: catalog-ready plus valid app credential allows
  the viewer query and project-update read; absent app credential is explicit.
- Status reads use `project`, not `projectId`, and reach the provider filter.
- A project-fenced lead reads its own status updates; arbitrary GraphQL is
  typed `project_grant_tool_denied`; another project's update stays refused.
- Room mutations, missing provider credentials and missing lane credentials
  refuse before provider dispatch. The fixture retains exactly one update.
- Scratch HOME and every XDG root share one scratch tree; teardown closes the
  fixture servers and stores. No installed process is involved.

The admitted native connected bridge separately reached live Linear as the
verified Clankie actor; `connected-viewer.json` is its raw read receipt. A
connected read of the latest project update also succeeded (receipt
`f496b77e-85b3-465a-a36f-2dba386e9c80`). Its complete response remains local
in `.local/vuh-2830/latest-status.json` and was delivered to the lead; its body
is outside this bug's evidence scope. Publication is not tested or authorized.

## Checks

All executed through `clankie heavy --`:

```sh
pnpm exec vitest run apps/clankie/test/linear-cli-lane.integration.test.ts apps/tui/test/install-doctor.test.ts apps/clankie/test/lane-mcp.test.ts apps/clankie/test/linear-request-budget.integration.test.ts
pnpm exec vitest run apps/clankie/test/linear-cli-lane.integration.test.ts --reporter=verbose --silent=false
pnpm --filter @clankie/tui typecheck
```

Focused set: 4 files, 71 tests passed. The final verbose route proof passed;
TUI source and all four test typecheck partitions passed. Root landing and
exact-patch standing review are reported separately on the issue. GLOBAL owns
integration, rollout and installed same-context doctor/query acceptance.

The first two root-gate failures are retained locally as
`.local/vuh-2830/landing-first-failed.log` (doctor discarded a connection-close
error) and `landing-second-failed.log` (fixture called an HTTP-only method on
Hono's server union). The doctor now reports close failures explicitly. Installed
`@hono/node-server` 2.0.8 declares `ServerType` as HTTP, HTTP/2 or secure HTTP/2;
the fixture follows `lane-mcp.test.ts` by checking `"closeAllConnections" in server`
before calling it, while retaining `server.close` callback error propagation.
The two corrections are retained in `.local/vuh-2830/cleanup-correction.diff`
and `fixture-lifecycle-correction.diff`. These failed gates are not green proof.

The receipts are bundled in [receipts.tar](clankie://evidence/sha256/a890b4e76117b0d5c65652fe3d133982d88f15b3f60d55b90bede164cc8fcbe1), published by `clankie evidence push`; only this README and
`evidence.json` belong in Git.
