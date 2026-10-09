# VUH-1859: idle remote Claude delivery

## Follow-up after 12c0fa70

Read-only checks of the original KH2 lead after the deployed canary passed:

- The pane is still idle/done and retains its native Claude session and cwd.
- Its native Claude process and launcher ancestry have neither `--channels` nor
  the development-channel flag. Managed policy enables channels and explicitly
  allows `clankie-worker@clankie`.
- Plugin installation is now 0.6.10; the original pane's startup observation
  still names 0.6.9. Replacing installed files does not change its launch flags.
- The Mac operator launcher supplies
  `--dangerously-load-development-channels plugin:clankie@inline`. The worker
  bridge uses `approvesWorkerChannel(parentArgv)` to start live polling only
  when the worker channel was selected at launch. Tools and outbound reporting
  can work without that inbound poll. The latest issue reproduction establishes
  stored inbound mail and a working outbound report, not an SSH link failure.

The roster now names Claude's current receiver as `live`, `next-turn-only`, or
`unverified`, using existing exact-occupant native polls and authenticated hook
observations. A next-turn-only warning appears after SessionStart without an
adoption or queued message, and remains after queue acknowledgment. A disconnected
channel can have the same observed limitation; the roster does not claim to know
launch arguments or declare a permanent harness limitation. Stored adoption
receipts warn too. The detail gives the exact native session's command:
`claude --resume SESSION_ID --channels plugin:clankie-worker@clankie`.
Recovery retains the original cwd and account/config home and needs coordinated
owner action between rig runs. The issue contains the private PC-specific command.

Integration coverage exercises real captain, fleet-link admission, disk journals,
HTTP and protocol parsing with native census/process observations supplied by the
fixture. It covers idle manual SessionStart before adoption, stored adoption,
service restart, take/acknowledgment, live polling and occupant replacement for
local and remote seats. The TUI test covers an idle next-turn-only lead with an
empty queue and bounded narrow rows. No native Claude model wake is asserted.
No PC input, restart, reconnect, config change or message replay was performed.
Live wake proof remains a separate check after an authorized channel-enabled resume.

PC observation, 2026-10-08 about 22:38Z. No PC pane input, configuration write, restart or plugin refresh.

- Claude 2.1.294; worker plugin 0.6.9 present.
- Managed policy enables channels and allows clankie-worker@clankie.
- Running Claude processes observed through Win32_Process have no --channels flags.
- Herdr default session is running. KH2 lead pc/w9:p2: terminal pc/term_65d0ca3cb067b2, status done.
- Service next-turn mailbox metadata: one live stored message, zero taken-unacknowledged, one acknowledged. No message body copied.
- Native bridge children exist, but presence is not live channel proof. Missing startup channel flag prevents channel polling in the installed bridge.
- Anthropic channel reference: https://code.claude.com/docs/en/channels-reference says an unloaded channel silently drops notifications. https://code.claude.com/docs/en/channels requires restarting with the channel flag. Channel transport support exists; enabling it in this original running process is not supported by the current setup, and restarting that process is outside assignment scope.

A second read-only observation found both PC link discovery files use schema 2
with `authentication: local-process`. The installed 0.6.9 `authorization()`
helper sends `x-clankie-pane` in that mode. The reported `remote_pane_required`
therefore does not justify a legacy-token header migration. The same code also
returns that refusal when fresh socket/process proof cannot bind the requested
pane. No native identity check was relaxed, and this observation does not prove
which original request failed.

Clankie's issue comment reports an unsubmitted draft typed into the lead pane.
The current source delivery path refuses unavailable steering and stores ordinary
messages only for an observed next-turn receiver; it has no terminal typing
fallback. No draft was submitted, pane changed, config changed or process
restarted by this assignment.

The change projects persisted queue metadata into the owner fleet roster and
TUI, and publishes a durable owner update naming the waiting pane. Only metadata
is copied. A hook take remains visibly unconfirmed until output acknowledgment;
reads do not drain, consume or replay mail. Acknowledgment, expiry and occupant
replacement remove current queue warnings.

Verification uses real disk journals, the owner update service and an HTTP/schema
boundary, including restart/deduplication and no message-body exposure. Native
Claude wake/consumption is not claimed. The PC proof above describes the original
lane; newly landed UI behavior has not been deployed there. The additional binding
repair and identification of the historical typing actor remain open.

## Host-side binding trace after the owner's restart

Read-only production process observations of the restarted lead found the native
Claude image loaded from `claude.exe.old.<13-digit timestamp>.<kernel pid>` beside
the independently resolved PATH launcher. The unmodified probe admitted only an
exact installed-image match, so its native process list was empty. The corrected
probe recognizes that same running process and reads its cwd in both observation
phases without changing the pane.

The repair admits only that installed launcher's exact predecessor name, with
the matching kernel PID and a rename timestamp within the process lifetime.
The launcher anchor does not grow as predecessors are observed. Fresh process
lifetime, pane ancestry and socket-owner checks still apply. Workspace grants
are unchanged. The process image replacement actor has not been identified.

`seat-routes.ts` requires a matching remote `projectProof`, but the observer in
`remote-project-proof.ts` receives fleet, shell and private-seat inputs, not
workspace grants. The parent-folder cwd is therefore not the observed cause of
this refusal. Workspace membership remains a separate check for project work.
An HTTP 403 `remote_pane_required` causes the installed inbound-receipt helper
to report `binding_rejected` before claiming or posting the report receipt.

The manual `windows-claude-predecessor.integration.test.ts` executes the production
admission function through real Windows PowerShell over authenticated SSH. It
covers the accepted predecessor and refusals for wrong PID, directory, launcher
name, pre-birth/future timestamp, extra suffix and nested predecessor. No remote
files or configuration are written. Run explicitly with
`clankie heavy -- env WINDOWS_CLAUDE_PROOF_HOST=HOST pnpm exec vitest run --config vitest.config.ts apps/clankie/test/windows-claude-predecessor.integration.test.ts`.

The live process observation did not include the original report request's
socket. It proves executable recognition, not successful report admission or
model consumption. Deploying this host change needs no PC pane restart for
process recognition. James can leave the pane running; project-scoped work
should still use a granted workspace. There is no reason to widen its grant.

## Pasted reports: evidence and remaining gap

The lead's native Claude transcript records direct `herdr agent prompt` dispatch
to KH2 workers, including kh2-steam and kh2-review2. This establishes use of
direct Herdr prompts in that workflow; it does not identify who inserted the
specific rev11/rev12 reports into the lead's input. Those workers' native Codex
session IDs were recovered from the read-only roster, but their source transcripts
were not found in the standard or alternate account session directories checked.
The observed launch wrappers still refer to legacy launcher routing; attributing
these reports to that routing would be inference.

Clankie's operator trace independently records the already-pasted reports at
22:41Z and a later owner-authorized prompt to the lead. That later prompt is not
the origin of the earlier draft. The current service, agent-host adapter and
Herdr plugin contain no report-to-terminal fallback. The original typing actor
and live report socket admission after deployment remain open. No PC input,
restart, config change or report replay was performed by this assignment.
