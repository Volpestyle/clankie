# Project membership and conversational onboarding source handoff

VUH-1534 and VUH-1538, Lark. This candidate extends the landed project/create,
role/cap and explicit CREATE review foundations. Source checks use disposable
state. Live app/model/native fleet acceptance is still open.

## Scope and decisions

James's 2026-10-04 decision supersedes VUH-1534's earlier “tools follow the
project” requirement: any pane in a Clankie-linked Herdr session gets all
connected tools through the two meta tools; link, bridge and per-call checks
remain (ADR 0217). This change preserves that policy.

VUH-1710 owns project villages and the World overhaul. This handoff adds no
district/station UI. The paused World cluster remains outside this work.

## VUH-1534

A hire keeps its explicit saved project/role independent of cwd. The hire ledger
now accepts native observer metadata without persisting workspace/private-seat
metadata as part of the original identity proof; this fixes remote observations
being rejected by its strict identity schema. Existing hiring admission continues
to resolve complete role profiles and enforce project/role caps, including zero,
concurrent reservations, reduced caps and changed profiles before native launch.

Agents with no hire allocation can resolve membership through actual native cwd
and the existing canonical workspace/linked-worktree resolver. Their role comes
from the project's saved assignment for the exact host-bound persona. A roleless
member stays roleless. An unconfirmed hire cannot fall back to cwd. The owner
membership read now supports local and registered Windows/PowerShell fleets,
qualified remote seats, exact native identity and final process/cwd/roster checks.
The role-assignment command retains qualified remote seat IDs and can update
verified workspace members through the same owner boundary. Unsupported hosts
and missing/ambiguous proof remain unknown. No assignment is
written by this display read, and connected-tool authority is unchanged.

All local and remote reads share four native permits and four proof batches.
Permits survive child cleanup. Initial remote binding has its own five-second
command bound; the subsequent proof/publication batch has a five-second deadline.
This is not a single five-second bound for every caller await, and native latency
in a live fleet remains unverified. SSH cancellation confirms the local owned
child exited, not termination of remote PowerShell work.

## VUH-1538

An unassigned verified owner workspace turn carries a read-only onboarding
opportunity: inspect its repo/convention, discuss tracker, proposed project roles
and fleet-size vocabulary through existing dialog questions, then offer
`propose_project_create`. Clankie retains the choice of questions and words.
Answers carry context only. No scripted model dialogue or new review artifact
was introduced, and actual model conduct has not been exercised.

The existing immutable CREATE artifact can include `trackerSetup`, the explicit
inputs of the shared work-init operation. It requires the primary tracker binding
and a missing canonical convention. Review/confirmation recheck owner authority,
settings revision and workspace/parent identity, including a newly created parent. CREATE records the tracker and
project roles/caps/fleet preferences; repeated confirmation reads the original
outcome. Existing conventions cannot be overwritten. No account selection,
provider project/label creation, grants or hires occur.

Tracker and project settings use separate writes. If the tracker saves and the
settings write fails, the proposal stays uncertain, the tracker remains, and the
consumed target cannot replay either write. The app's existing CREATE review
shows tracker inputs and every role hire-profile field; uncertainty copy mentions
that tracking may have saved. No changes to WorldView, StationsLayer, station
model/context or village visuals are included.

## Evidence and remaining acceptance

Focused raw logs are in [evidence](evidence/). They cover actual disposable
SettingsStore/conversation persistence, original-target confirmation, tracker
choices for all four backends, no replay after partial failure, changed source
and revoked-authority refusals, membership lifetime/cwd checks and role/cap
admission. Native observer seams in the fleet/hire tests are controlled fixtures;
the owner-started cwd case uses a real owned local process and actual cwd read.
They do not prove a live Windows fleet, installed TUI launch or live model beats.

No full gates or evals ran. The integrator owns full gates. iPhone/iPad layout and
normal app/native hiring acceptance remain open pending the lead's simulator
slot. Lark's two temporary simulators were shut down and deleted after the
machine-load incident; all later heavy steps use the fleet limiter. VUH-1710's
app owner owns village and confirmed-station visual acceptance. The lead closes
these issues only after landing and the remaining relevant acceptance evidence.
