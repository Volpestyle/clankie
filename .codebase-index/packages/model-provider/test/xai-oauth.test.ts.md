# packages/model-provider/test/xai-oauth.test.ts

SuperGrok OAuth suite over fake transport/store.
It covers device-code requests, pending and
slow-down polling, denial without persistence,
refresh-token preservation, rejection of API-key
refresh, placeholder-bearer replacement,
single-flight concurrent rotation, revocation
before the next request, and JWT expiry skew.
