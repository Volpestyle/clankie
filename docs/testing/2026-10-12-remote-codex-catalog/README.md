# VUH-2144: remote Codex private catalog and unsent briefs

Related: [VUH-2144](https://linear.app/vuhlp/issue/VUH-2144), [VUH-2143](https://linear.app/vuhlp/issue/VUH-2143).

## Diagnosis

Read-only PC observations on deployed `4dd34fff2` confirmed the original
`pc/w14:p4` native session and its reconnecting view. The hired backend's
loopback listener was gone. Its native SQLite log identifies process `806544`
and repeated worker MCP initializations alongside the controller's unfiltered
`mcpServerStatus/list` requests. The fleet's PC-to-Mac loopback link answered;
the remote host's hire receipt remained `launching`.

Codex 0.160 reads an original thread's runtime snapshot when both `threadId`
and `serverName` are supplied. Its unfiltered path creates a discovery snapshot
from current configuration instead. See the
[native request processor](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/request_processors/mcp_processor.rs#L275).
Our private catalog poll omitted `serverName`; startup then closed the backend
after rejecting the brief, leaving its already-open TUI reconnecting.

## Change

Private readiness and catalog observation now pin `worker` on the original
loaded thread. A typed controller error proves failures before the turn RPC;
loss of acknowledgment after that boundary still retains uncertainty.
An initial pre-dispatch refusal returns `briefDelivery: "not_sent"` and
`deliveryStage: "unavailable"`, keeps its native control/view, and durably
retains the hire's launch guard. A retry or service restart cannot replay the
original brief or launch a duplicate. This does not claim that no native
process was launched.

## Verification

- 142 focused tests passed across eight suites: native app-server transport,
  adapter, hire consumer, hired-seat protocol, remote launcher, fresh-intent
  recovery, worker catalog bridge and protocol delivery. One existing optional
  native case skipped.
- Real installed Codex, private scratch `CODEX_HOME`, original ephemeral
  thread and actual MCP transport: a pinned catalog remains connected after
  fresh discovery becomes unavailable. No model turn or tool call was made
  by this proof. Three unrelated native cases were deliberately unselected.
- Final adapter and hire consumer checks pass, including persisted not-sent
  behavior after reconstructing the store. Transitive TypeScript, touched-file
  formatter and lint checks pass.

The PC was only read. Its original pane was neither steered nor closed; no
credential, account, link, installer or deployment was changed. Corrected
Windows hire proof after deployment belongs to the KH2 lead. Existing legacy
uncertain receipts were not rewritten from error strings. Integration supplies
the final exact-tree gate and landing record.

Raw check logs, source diff, source hashes and sanitized native observations
are retained by the accompanying evidence manifest.
