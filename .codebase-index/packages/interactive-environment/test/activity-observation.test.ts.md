# packages/interactive-environment/test/activity-observation.test.ts

Self-observation contract suite. Covers: the
structural separation of selfAuthored vs
runnerObserved on a parsed snapshot; the
`pending` (live, no settled turn) and
`not_playing` read outcomes; and rejection of
over-length commentary and of frame bytes
smuggled into runnerObserved.
