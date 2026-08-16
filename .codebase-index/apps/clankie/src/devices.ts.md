# apps/clankie/src/devices.ts

The device projection: `DeviceRegistry` (a Map)
rebuilt from `device:*` event streams.
`applyDeviceEvent()` is the single application
path for both live writes and boot replay, so
replay parity holds by construction.

Handles pairing.redeemed (→ pending),
activated, session.refreshed, grant.denied
(audit-only), and revoked. Fail-closed: an
unparseable device event or impossible
transition throws rather than booting a corrupt
log silently. Also exports
`isDevicePendingExpired()` (expired pendings
read as absent) and `deviceListItem()` (the
secret-free operator list row).
