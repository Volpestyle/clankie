# apps/clankie/src/operator-auth.ts

`createCredentialBackedOperatorAuthenticator()`:
an `OperatorAuthenticator` that resolves the
authoritative operator credential from the
broker on every request, so rotation is atomic
across server and clients without a restart.
Store failures and invalid credentials fail
closed (return undefined). Delegates the actual
compare to `createBearerAuthenticator` from
app.ts.
