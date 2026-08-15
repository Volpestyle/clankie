# apps/discord-activity/test/frame-hub.test.ts

Pins the hub with structural viewers: a late
viewer receives the current frame and overlay
instead of a blank canvas; a backed-up viewer has
frames dropped (counted on droppedFrameCount) but
still receives lifecycle `stopped`; the viewer
cap closes over-cap viewers; a frame whose
byteLength disagrees with its payload and an
over-long overlay monologue are rejected by
schema.
