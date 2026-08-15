# apps/clankie/test/activity-observation.test.ts

Unit tests for
`ActivityObservationProjection`: publish returns
defensive clones (mutating a read never leaks
back), same-session sequence regression throws,
and `clear()` only erases the matching session.
