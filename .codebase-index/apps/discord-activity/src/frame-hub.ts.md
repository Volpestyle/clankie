# apps/discord-activity/src/frame-hub.ts

`RenderedSurfaceHub` is the latest-only frame/overlay fan-out. It validates shared protocol messages, immediately seeds late viewers, caps viewers, counts frame drops for socket backpressure, and never drops lifecycle messages.

`snapshot()` exposes the current PNG to the loopback Go Live source. `stop()` clears retained state and closes every structural viewer, so no ended session remains labelled live.
