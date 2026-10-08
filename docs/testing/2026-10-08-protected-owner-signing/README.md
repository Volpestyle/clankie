# Protected owner signing: proposal only (VUH-1687)

[ADR 0253](../../adr/0253-owner-confirmation-needs-an-isolated-authority.md)
is Proposed. The owner authorized its documentation landing and left
implementation unstarted. James still chooses the isolation boundary and
protected action set. No installer, OS identity, Keychain enrollment, signer,
API behavior or live settings changed.

The recommendation combines an isolated authority that owns protected effects
and state with local per-action user-presence signing. A non-exportable key
alone cannot protect a same-user mutable verifier or state.

## Current-boundary checks

Commands and results are retained in [checks.txt](checks.txt). The existing
real HTTP goal-activation and machine-access integration suites use disposable
broker/device fixtures. They check today's bearer-backed authorization and
revocation, not same-user resistance, hardware presence or protected signing.
Documentation checks verify links and retired claims. No secrets were read or
printed. No native installation or hostile same-user proof was attempted.

Both VUH-1687 acceptance criteria remain open: this is a proposal, not a selected
implemented boundary. Its native proof requirements are listed in ADR 0253.
