# VUH-1859: idle remote Claude delivery

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
