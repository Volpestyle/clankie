# Fresh terminal permission checks — #909

Draft implementation: [#910](https://github.com/Volpestyle/clankie/pull/910).

`POST /v1/operator/computer/permissions/refresh` with `{schemaVersion: 1}`
asks the configured local terminal for a non-prompting check. CLI:
`clankie computer permissions --request --json`. A cache read remains a cache
read; the existing explicit local `--refresh` command is unchanged.

The integration batch passes **221 tests across two files, zero skipped**.
It uses the real owner HTTP service, pairing journal, owner/owner-child tokens,
CLI transport, Unix-socket clients and diagnostic subprocesses. Terminal servers
are isolated fixtures. Both the Herdr new-tab protocol and herdr-core's
handshake/terminal-run protocol are exercised. Tests cover:

- Owner and owner-child success; visitors, their descendants, supervisors,
  captain and unknown bearers refused before dispatch.
- Revocation before dispatch and during launch/cleanup, with no publication.
- Closed body/query, relay forwarding with the original bearer, strict response
  validation, unavailable contexts, stale/future results and wrong nonces.
- One active check even during asynchronous host selection; bounded timeout,
  no replay of an uncertain launch, no cached result returned as a fresh check.
- Changed terminal binding during cleanup, exact diagnostic cleanup, and saved
  choices/ceilings unchanged.

The base route from `821a2864a` fails the new HTTP success sequence with 404.
Targeted reversions of the final owner guard, nonce binding and final terminal
binding check are also caught. A fifth mutation that requests Herdr focus is
also caught. These are local mutations, not skipped or weakened
expectations.

All four affected packages pass TypeScript 7 checks. Focused lint/format,
dead-code and documentation checks run through `clankie heavy`, as do tests.
The declaration entry in Knip follows the existing native-module declaration
convention; no file or issue category is ignored.

## Native limits

The shipped native diagnostic was exercised through real HTTP and Unix IPC on
this Mac. It returned `terminal_context_unavailable` in this worker's ancestry;
caller-supplied terminal names were not substituted. Positive observations above
are labelled fixture data. No positive native TCC grant or GUI-terminal launch
is claimed. The diagnostic uses non-prompting preflight calls only.

No permission prompt or grant, app/phone installation, owner-screen action,
existing pane input, service restart, remote machine or live account was used.
Reports remain advisory, expire after one minute, and never authorize desktop
work. A report covers only the application it names, not every terminal or
harness on the Mac. Independent review is required before this new API boundary
lands; the pre-merge rebase remains pending.

The Herdr request asserts `focus: false`. The desktop request asserts empty
window-adoption labels, no parent or parent notification, automatic removal and
no keep-alive shell. No focus/bring-forward API is called. Actual GUI focus
preservation remains unproven: no owner window was observed or controlled.
