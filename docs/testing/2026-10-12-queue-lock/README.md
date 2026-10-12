# VUH-2157 merge queue lock

Tracks: https://linear.app/vuhlp/issue/VUH-2157/merge-queue-requests-submitted-right-after-a-deploy-fail-on

The queue drain now waits behind a proven live lock owner, including the freshly
started service's reclamation sweep. Requests keep their original IDs and stay
queued until the owner releases the lock. Unknown owners and observation errors
still fail visibly; a newly dead owner reports its PID and timestamp as a retained
stale lock. Existing prior-boot dead-owner recovery remains intact.

Focused integration checks pass for three real authenticated CLI/HTTP requests,
real filesystem locks, Git composition, gates and pushes to fixture remotes. All
three remain queued behind the live maintenance lock and land without
resubmission after release. The dead-owner case retains the lock and leaves the
remote unchanged. Prior-boot recovery and its interrupted records also pass.
Scoped lint and formatting pass. The integrator supplies the exact-tree gate.

`scenarios.jsonl` retains queue and terminal records. `checks.json` includes the
focused output and lint/format results. These tests use a real lock but do not
claim to be a production deploy.

**Pending:** requests during and immediately after the next real `clankie update`.
The lead will announce that window after this fix lands and will perform the
update. No service restart or deployment was performed by this worker.
