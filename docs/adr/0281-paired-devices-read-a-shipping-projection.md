# 0281 — Paired devices read a shipping projection

Status: accepted. Tracks VUH-2526.

The app needs queue state without Git execution authority. Keep POST `/v1/integrate`
operator-only, and expose GET `/v1/integrate/shipping` through the existing paired
device and relay route patterns, with the same owner-device boundary as the fleet
roster. Support and visitor devices remain excluded.

The projection reads the existing durable integration status. It carries issue keys
from commit subjects, states, recent outcomes and pending request counts. It omits
local paths and command output. The app joins keys to its project tracker items;
unmatched keys never acquire guessed project membership. Recent outcomes are bounded
to 30; the CLI remains the complete diagnostic surface. No runtime deployment or
restart is required to land this contract; older services simply lack the new route.
