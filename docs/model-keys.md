# Model keys from a paired app

Hosted and self-hosted bodies expose the same owner model setup API. Use
`@clankie/protocol/model-keys` for the schemas and route constants. The catalog
comes from the same Pi runtime, models.dev fill, configured local providers,
and enabled/disabled provider policy as the console's `/model` picker. Selection
writes the same config as `clankie model set`; it is not a second model system.
`FEATURED_MODEL_PROVIDERS` is the shared promotion order for `/auth` and account
setup, not an exhaustive support list.

Every route requires the local operator bearer or an active paired device whose
current grant includes `terminalControl` (Take Control). Chat, steer, terminal
observation, captain and worker credentials cannot manage keys. Hosted pairing
offers Take Control; the app must accept it when completing pairing. Revocation
takes effect on subsequent requests. All public gateway calls use the existing
device-to-body encrypted envelope; plaintext application requests are refused.
An authenticated direct local API remains available on self-hosted Macs.

| Method | Path                      | Request                                                 |
| ------ | ------------------------- | ------------------------------------------------------- |
| GET    | `/v1/model-keys`          | none                                                    |
| POST   | `/v1/model-keys/set`      | `{ "providerId": "openai", "apiKey": "…" }`             |
| POST   | `/v1/model-keys/validate` | `{ "providerId": "openai", "modelId": "gpt-4.1-mini" }` |
| POST   | `/v1/model-keys/select`   | `{ "model": "openai/gpt-4.1-mini" }`                    |
| POST   | `/v1/model-keys/remove`   | `{ "providerId": "openai" }`                            |

GET returns this secret-free projection (the example model is illustrative;
always populate pickers from the response):

```json
{
  "model": null,
  "effectiveModel": null,
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "acceptsApiKey": true,
      "keyConfigured": false,
      "models": [{ "id": "gpt-4.1-mini", "name": "GPT-4.1 mini" }]
    }
  ]
}
```

`model` is the configured captain reference; `effectiveModel` includes the
CLI's existing subscription precedence and is null if selection is unresolved.
References split on the first slash, so model IDs can contain slashes.
`keyConfigured` reports only an API key stored in the broker; it does not reveal
OAuth credentials, environment fallback, a key prefix/suffix, or endpoint headers.
Providers without API-key auth are listed with `acceptsApiKey: false`.

POST results are exactly `{ "ok": true }` or `{ "ok": false, "error": CODE }`.
Codes: `authentication_required` (401), `forbidden` (403), `unavailable` (503),
or `malformed`, `unsupported_provider`, `unsupported_model`, `key_missing`,
`validation_failed`, `validation_timeout` (400). Bodies over 16 KiB return
`malformed` with 413. All responses have `Cache-Control: no-store`.
Unknown request properties are refused. Provider IDs are at most 128 characters;
model IDs/references at most 512. Keys are trimmed, nonempty, at most 8192
characters and cannot contain control characters.

Set stores or replaces the key in the credential broker immediately; it does not
validate it implicitly. Then validate against a model from that provider's
catalog. Validation uses the stored key explicitly (no environment or OAuth
fallback), a fixed tiny prompt, no tools or customer context, at most 16 output
tokens, no retries and a 15-second deadline. The provider may charge for this
small request. It returns only success or a fixed error code, never generated
text or an upstream error. A failed validation leaves the stored key in place so
the owner can replace or remove it. It does not change the active model.

Select takes effect on the captain's next turn; an in-flight turn keeps its
current model. API keys are read from the broker for subsequent requests. No
terminal or restart is required for these operations. Declaring a new local
provider or refreshing catalogs still follows the [CLI configuration flow](cli.md).
Remove is idempotent and removes only a stored API key, not OAuth, environment
variables or the selected model. A Mac's existing environment fallback can still
authenticate that provider after removal.

Keys are write-only. Never put them in URLs, conversation messages, command-line
arguments, logs, event records, telemetry, support bundles or analytics. The app
should clear its input after submitting and must not persist the plaintext key.

When body telemetry is enabled, these operations emit `body.model` metadata:
`action` is `key-set`, `key-replaced`, `key-removed`, `model-selected`, or
`key-validated`; `result` is a closed outcome code. A successful provider probe
emits `key-validated` / `ok`; merely storing a key does not imply it works.
Validation refusals before a provider request do not emit a validation event.
Unchanged selection and removal of an absent key do not emit change events.
Only IDs in the bundled public catalog may appear as `providerId` and, for
selection only, `modelId`. Custom names, unrecognized input, keys and provider
error text are omitted. Catalog identifiers allow letters, digits, `.`, `_`,
`:`, `/` and `-`, up to 128 characters; credential-shaped values are refused.
The existing emitter adds `v` and `atMs`, and the host shipper adds tenant and
instance identity. Telemetry failure never changes a write's result.
