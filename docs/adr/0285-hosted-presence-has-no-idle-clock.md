# ADR 0285: Hosted presence has no idle clock

Status: accepted by the owner, 2026-10-20 ([VUH-2575](https://linear.app/vuhlp/issue/VUH-2575)). Managed-service rollout pending.

## Context

The accepted [positioning decision](https://linear.app/vuhlp/document/clankie-positioning-draft-1a1d7434ba9e)
promises continuous hosted presence and scheduled Auto rounds while the owner's
laptop is shut. Sleeping on inactivity or a monthly active-body-hour allowance
prevents that: without a live body, Discord, voice availability, relay access and
scheduled rounds all depend on a new external wake.

## Decision

An entitled hosted body remains running across idle periods. Runtime duration is
an operational cost measurement, not an allowance or an hourly overage charge.
Existing bodies stopped by the old idle/hour policies recover without requiring
owner-device traffic. Explicit owner pauses, billing suspensions, failed-boot
protection and independent protective data limits remain in force.

Inference is admitted and settled against AI credits, with bounded spending.
Exhausting inference credits refuses paid work rather than sleeping the body.
Managed bodies use credits only; self-hosted model authentication remains
first-class. Burst is deferred from Premium's first release, and any future
burst needs a demonstrated handoff and credit-accounting path before advertising.

This does not make a sleeping linked machine's desktop tools or simulators
available. Those jobs wait for compatible execution resources. Nor does this
establish local-to-hosted identity transfer; that requires its own continuity
proof before an upgrade can promise preservation of everything.

## Consequences

Continuous infrastructure costs must be measured and projected from actual
resources and workload evidence in private clankie-ops. VUH-1062 receives a
Premium pricing recommendation; the owner decides repricing. This decision
changes no prices, Stripe products or plan copy.

The lifecycle implementation and rollout belong to clankie-ops under
[ADR 0183](0183-the-harness-is-public-the-hosted-service-is-private.md).
Public docs describe the decision and mark rollout status honestly. An isolated
reconciler check cannot prove deployed Discord, voice, phone/relay reachability
or a scheduled Auto round with the laptop shut; those remain deployment
acceptance evidence. See [always-on guidance](../always-on.md).
