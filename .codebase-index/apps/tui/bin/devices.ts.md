# apps/tui/bin/devices.ts

Narrow operator client for device management:
`listDevices()` (GET `/v1/devices`) and
`revokeDevice(id)` (POST `.../revoke`), bearer-
authenticated with the operator credential and
validated against `DeviceListItemSchema` from
`@clankie/protocol`.

Fails closed via `DevicesCommandError` with a typed
status (`unavailable`, `unauthorized`, `not_found`,
`malformed`, `interrupted`) mapped to content-free,
actionable messages — never a response body or token.
`grantSummary()` renders a device's grants compactly
(`chat+steer+observe`).
