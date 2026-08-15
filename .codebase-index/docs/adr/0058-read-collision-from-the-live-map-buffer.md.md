# docs/adr/0058-read-collision-from-the-live-map-buffer.md

Collision is read, not remembered: FireRed's live
map buffer (`gBackupMapLayout`, IWRAM) is decoded
so walls are known before walking into them, and
`walk_to` becomes a catalogued BFS route action
verified every step (an occupied or warp tile
stops the route honestly).

Read for the measured motivation (14 tool calls
to cross a bedroom), the border-filler trap
(void decodes as open floor — clamp to the real
map), "collision is not reachability", and the
rule that action results carry position / moved /
turned / surroundings so a bump is legible without
a second call. Extended by ADR 0089 (warps and
minimap).
