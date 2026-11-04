# 0358. The doorway budgets connector work by what the Mac vouched for

Status: Proposed, 2026-11-04, for the doorway connector rate limits.

The Claude connector ([ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md))
reaches the Mac through public routes on the gateway, and the Mac authenticates
every call. The gateway needs budgets in front of those routes, but it can't check
a connector token: only the Mac can. Budgeting everything together treats a
signed-in client the same as a caller nobody knows.

## Decision

Connector calls spend one of three per-host lanes, plus a per-source budget for
callers the Mac has not vouched for:

- **Established:** tool calls and refreshes with a credential the Mac issued or
  accepted.
- **Sign-in:** the page's polling from a source the Mac opened a sign-in page for,
  and the exchange of a code the Mac released to a sign-in page.
- **Anonymous:** everything else, charged to its source first, so a call the source
  budget refuses spends nothing shared.

The gateway learns this only from the Mac's own replies, so it now reads the
connector's token, status and sign-in responses as they pass. It keeps hashes in
memory, never the credentials, and a 401 or 403 forgets a bearer. Source budgets
live apart from host lanes, so many sources can't crowd a host's lanes out of the
budget table.

The relay's `/mcp` answers 2xx only after authenticating the bearer. That is a
contract: a success there is what teaches the gateway a bearer, so a route change
that answered 2xx first would let a caller into the established lane.

What the gateway remembers is bounded per host and across hosts, and goes when a
host's connection ends. Losing it only returns calls to the anonymous lane.

The token route's credential is in its form, so that form is read before a lane can
be chosen. That read has its own limits, because the gateway's in-flight cap counts
dispatched exchanges, not bodies still arriving: a size limit checked against the
declared length first, a three-second deadline on each held read, a cap on reads at
once and per source, and a source budget for starting one. The deadline bounds one
read, not delivery: a caller can still wait behind others and retry. At most 80
reads run at once: 64 for anyone, and 16 more only for sources the Mac has vouched
for, so refreshes keep moving when anonymous reads fill the rest.

A lane decides who waits, never what anyone may do. The Mac still authenticates
every call, and being remembered here grants nothing.

## Consequences

This is best-effort fairness, not flood resistance. Anonymous callers share a lane,
so a new sign-in or a client the gateway doesn't yet remember can still wait behind
others. A gateway restart or a host reconnecting forgets everything, and each
client's next call starts anonymous. A code exchange from a source the Mac hasn't
vouched for can wait behind anonymous reads. A sign-in lane needs its polling to come from the source that opened the
page. Volumetric protection belongs in front of the gateway.

A host can now take more connector calls in total than the single budget allowed,
because the lanes add up. The established lane keeps the old limit, so signed-in
work loses nothing.

## Evidence and limits

This remains a proposal. Its three-second held-read deadline and 80-read split are bounded design choices, not measured flood resistance or a throughput promise. The gateway source and connector contract named above are the implementation context; this record has no retained load experiment proving that these are optimal thresholds.

## Revisit when

Real connector traffic shows legitimate refresh/sign-in starvation, gateway resource use changes, or host-authentication replies change shape. Measure per-lane completion and rejected/expired reads before tuning the split, and preserve the rule that gateway classification never grants Mac authority.
