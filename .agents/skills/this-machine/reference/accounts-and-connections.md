# Accounts and consent

Read `clankie accounts list` for the body's catalog, configuration status,
account identity, granted scopes and latest check. The app's Connections sheet,
account dashboard and console `/connect accounts` use these same rows. Do not
invent a service's permissions or infer authorization from an account name.

`clankie accounts connect google-gmail`, `google-calendar` or `google-drive`
starts body-owned Google consent. The URL requests only that capability's
scopes: Gmail/Calendar are read-only plus `openid email`; Drive requests only
`drive.file` and opens Google's file picker. The body retains PKCE state, verifies
the Google identity and keeps refresh/access credentials in its own broker.
Only an owner/operator or an authorized Take Control device may run the flow.
Never collect a Google token, authorization code or developer secret in chat.
Send the owner to the account sheet or `/connect accounts`. The console masks
the returned `clankie://accounts/google/callback` link; automation sends
`{state,code}` to `accounts complete google-PROVIDER --json-stdin`.
Drive completion also supplies `pickedFileIds`, validated from the callback's
comma-separated `picked_file_ids` value.

Gmail reads messages and labels; it cannot send, change or delete mail.
Calendar reads the calendar list and events; it cannot write events.
Drive uses `drive.file` and the system Google Picker to authorize selected
files, with no broad Drive scope. That Google permission permits editing
selected files, while Clankie's implemented tools only read. Disclose that
distinction before consent; never claim the Google grant is read-only or
request `drive.readonly` as a fallback for missing file access.

Use `clankie accounts check google-PROVIDER` for a bounded access check.
`awaiting_consent` is unfinished authorization. `expired` needs refresh;
`reconnect_required` needs a new browser consent. `unavailable` reports a
provider failure and does not establish that consent was revoked.

`clankie accounts disconnect google-PROVIDER` disables all three Google
connections on this body because Google's application grant is shared.
Local access stops even if Google is unavailable. Report `revoked: false`
as pending provider revocation; retry disconnect or send the owner to the
returned Google management URL. Claim revocation only after a confirmed
`revoked: true` result. Tenant/body credentials and flow state are private to
that body; never reuse one tenant's callback or token for another.

An `unconfigured` Google row needs operator setup of the developer OAuth
client, not a customer credential. For local development, use
`accounts apps set --google-client-id ID --google-redirect-uri URL` for
public settings. Store the matching secret only through the local operator
command `accounts apps google-secret --client-id ID --secret-stdin`.
It refuses hosted bodies and remote transports. Never put the secret in
arguments, environment variables, settings or a portal. Developer client
registration, consent-screen setup and real account consent remain owner
actions; fixtures do not prove a real Google read.
