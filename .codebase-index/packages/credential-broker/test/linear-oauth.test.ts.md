# packages/credential-broker/test/linear-oauth.test.ts

Linear OAuth unit tests over a fake fetch. They
pin PKCE/scopes/resource in the authorize URL,
dynamic public-client registration and code
exchange, refresh-token preservation when Linear
does not rotate it, account-id preservation, and
the one-minute expiry skew.
