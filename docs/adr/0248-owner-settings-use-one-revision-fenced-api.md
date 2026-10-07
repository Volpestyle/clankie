# ADR 0248: Owner settings use one revision-fenced API

Status: Accepted (2026-10-07; VUH-1813).

## Decision

Fleet, persona, voice, Discord fields, worker-account holds, Linear follow/wake
and host availability settings have one owner API. CLI and TUI read its current
snapshot and send its revision with each update. They never retry a conflict
or write settings.json after an API error. The service validates the update
and rechecks revision and current owner authority before persistence. Response
reads use the existing protocol parser for additive optional fields
([ADR 0016](0016-versioned-interactive-environment-contract.md)); requests
retain strict validation.

Keep-awake and automatic update preferences live at
`GET`/`POST /v1/operator/host-settings`; their wording and schemas belong to
`@clankie/protocol`. Non-Mac and hosted bodies refuse keep-awake; managed hosting
keeps automatic updates enabled. A setting stores intent; changing a preference
does not grant deployment, restart, credential or account authority.

Device forwarding preserves the original device identity and requires current
Take Control authority before and after forwarding. Host settings, voice,
worker-account holds and Linear follow/wake are explicit relay and hosted
operator routes. Persona's paired-device projection remains talkativeness only;
the operator route owns its full character settings. Linear GET snapshots gain
revision; POST and the retained local PUT alias require an expectedRevision
and a nested wake/following value. Old unfenced writes fail validation.

The explicit `awake --local-setup on|off` command may prepare a local Mac
before the service runs; it refuses remote transports. Ordinary `awake` and
`update auto` require the owner API. When a host preference is saved but its
runtime application fails, the API returns 503 with `saved: true` and its saved
snapshot; read GET to reconcile rather than blindly resubmitting.

Local setup remains available where the service may legitimately be down:
first-run machine wiring (autostart, working directory, execution connections),
local Claude profiles/Codex homes and signed Linear webhook URL setup. Provider
credentials use their own broker/account boundaries. These separate setup
operations never become an automatic fallback for ordinary owner settings.

## Consequences

Every surface can share validation and detect a stale update. App/dashboard
controls bind to the public contracts separately. Existing API consumers must
read revisions and adopt the fenced envelopes. Checks exercise real HTTP,
settings persistence, schema and credential boundaries; they do not restart a
service, install a release or contact voice providers.
