# apps/discord-activity/src/producer.ts

`createFrameProducerServer()` owns loopback-only, timing-safe bearer-authenticated frame ingress. The newest authenticated WebSocket owns the session; stale/superseded sockets cannot publish or stop it, and disconnect ends the surface.

Validated frame/overlay/stopped messages feed `RenderedSurfaceHub`. An authenticated HTTP snapshot path returns the hub's latest PNG for user-session Go Live publishing; every other HTTP/path/auth combination stays closed.
