# docs/adr/0099-he-can-look-at-his-own-play.md

Clankie can pull one live framebuffer still and a
bounded story card from his current playthrough.
Realtime `look_at_screen` seeds an image item;
captain `observe_current_activity` returns the same
still, while `recall_play` and the live story route
project journal history.

The story contains turns, current objective, maps,
and the last eight speak-worthy effects — never
monologue, notes, or raw JSONL. These remain
read-only seams; room audio gains no button press,
memory write, or play-start authority.
