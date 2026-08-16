# apps/clankie/test/embodiment-operator.test.ts

Operator play controls over the routes: the live
stop requires operator auth, answers 404
not_playing rather than minting a ghost stop,
and attributes a real stop to the operator.
Live-session reads are authenticated; the
activity route projects the runner's latest
snapshot to captain and operator, returns
pending before the first turn, and fails closed
(502 identity mismatch) when the snapshot
belongs to another session.
