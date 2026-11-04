# ADR 0356: The app signs this Mac in

Status: Proposed, 2026-11-04, for #722. Amends [ADR 0153](0153-an-account-signs-the-mac-in.md).

## Context

The account sign-in ran only inside the CLI and console. The Mac app's setup
page (clankie-app ADR 0169) needs one row for it, so the service needs routes,
and those routes handle the credential that opens this Mac to the internet.

## Decision

- **Three routes, on this Mac only.** `GET /v1/mac-account`, `POST
/v1/mac-account/start` and `POST /v1/mac-account/complete`. Admission checks
  the socket first: a request that is not this Mac's own loopback is refused
  whatever its credential, the operator bearer included. Then the caller must be
  the operator or a device with Take Control, as for the pairing offer
  ([ADR 0314](0314-setup-adds-the-phone-and-the-tailnet.md)). The paths are on
  neither the gateway's nor the hosted operator's allowlist.
- **Nothing secret crosses them.** The app sends an email and a code. The Cognito
  session stays in the service's memory and the tokens go to the broker. Refusals
  carry an error code and never repeat Cognito's message. Settings name the
  gateway; the caller cannot.
- **A code belongs to whoever asked for it.** Only the identity that started a
  sign-in may finish it, within five attempts and ten minutes. A new start
  replaces the last.
- **One code path.** `clankie login`, the `/gateway` wizard and `complete` all
  end in the broker's `storeClankieAccountSignIn`. The CLI still works with the
  service down, so it calls the broker directly rather than these routes.
- **The email is kept beside the tokens.** Status reports it from the broker
  credential's metadata. A Mac signed in before this reports no email until it
  next signs in.
- **The service restarts to open the doorway.** Only boot builds the connector,
  and pairing, push and connector routes hold it from then on. `complete` uses the
  idle cutover a body transfer uses: close admission when no turn or voice is
  live, exit, and let the launcher's recovery start it again. While he is busy it
  answers `restart: "waiting"` and keeps trying.

## Consequences

- Swapping the connector in place would avoid the restart, at the cost of
  rewiring everything that holds it. If the restart proves disruptive, that is
  the follow-up.
- A service not started by the launcher exits and stays down after a sign-in.
- Signing in with a different account changes this Mac's host id, as `clankie
login` always has, so paired phones must pair again.
