# apps/clankie/src/captain/port.ts

`CaptainPort` is the boundary between authenticated HTTP routes and Pi runtime ownership. It submits Discord turns, serves operator-conversation requests, returns protocol-native observable lanes, supplies the realtime voice instruction fragment, and closes active sessions.

`createStubCaptain()` provides an overrideable no-model stand-in for route tests; `LaneObservationEntry` aliases the shared protocol type.
