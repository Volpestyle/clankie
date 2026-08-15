# apps/relay/src/device-auth.ts

The device-auth port and its production
implementation. `RelayDeviceAuthorizer`
must resolve current device state on every
call — a signed token alone is identity,
never live authority.

`ControlPlaneDeviceAuthorizer` calls the
clankie service's `/v1/devices/self` with
the device bearer (5s timeout): the
service verifies the HMAC session token
and reads the durable device projection,
so revocation takes effect on the next
relay request or tail poll. Results map to
`{authorized, device}` or a typed denial —
`invalid`, `expired`, `revoked`, or
`unavailable` (network failure, 503, or an
unparseable body). Raw responses are never
retained.
