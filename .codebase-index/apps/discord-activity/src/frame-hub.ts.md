# apps/discord-activity/src/frame-hub.ts

RenderedSurfaceHub: fan-out for the frame stream.
Holds only the most recent frame and overlay —
not a recorder — and validates both against the
interactive-environment schemas before
broadcasting.

Viewers are structural ({send, bufferedAmount,
close}) so tests never open sockets. addViewer
sends the current state immediately (no blank
canvas for late joiners) and refuses over the
viewer cap (default 64); frames are dropped —
counted on droppedFrameCount, never silent — for
a viewer whose socket backlog exceeds
maxBufferedBytes (default 512 KiB), while
lifecycle `stopped` messages are never dropped.
stop() notifies everyone, disconnects them, and
clears the snapshot.
