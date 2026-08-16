# packages/credential-broker/src/credential-store.ts

Typed at-rest storage for provider credentials,
keyed by normalized providerId. Credentials are a
zod union: `api` (key + metadata), `oauth`
(access/refresh/expires/accountId plus optional
dynamic-registration client id/secret), `wellknown`
(key + token). `redactCredential` reduces any of
them to a display-safe summary; `list()` never
returns secrets.

- `FileCredentialStore` — one 0600 JSON file in a
  0700 directory; atomic temp-file+rename writes;
  same-path writers serialized in-process. A
  corrupt file is a hard error (never silently
  overwritten); individually invalid entries are
  skipped and surfaced via `loadIssues()`.
- `KeychainCredentialStore` — macOS `security`
  CLI via `execFile` (never a shell): one generic
  password per provider under service
  `bot.clankie.credentials`, plus an `__index__`
  item listing providerIds so list() never dumps
  the keychain. Set writes the index before the
  secret and rolls back on failure; delete
  removes the secret first and tolerates a stale
  index entry. The `-w <json>` argv is briefly
  ps-visible — an accepted tradeoff, documented
  inline.
- `createDefaultCredentialStore()` — Keychain on
  darwin, else `~/.config/clankie/credentials.json`;
  `CLANKIE_CREDENTIALS_FILE` forces the file
  backend (tests/CI).
