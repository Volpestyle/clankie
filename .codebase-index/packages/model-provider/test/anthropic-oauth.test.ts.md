# packages/model-provider/test/anthropic-oauth.test.ts

Anthropic OAuth tests: S256 challenge, the
manual-code authorize URL, verifier/state
separation, state validation before exchange, the
JSON token contract, broker-only persistence from
the browser flow, refresh preserving the prior
refresh token, refusal to refresh API-key
credentials, and the fetch adapter — API key
stripped, bearer plus required beta features
attached, one shared refresh across concurrent
requests, and broker revocation honored before
the next request.
