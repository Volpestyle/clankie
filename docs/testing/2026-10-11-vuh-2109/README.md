# VUH-2109: automatic turn routing and observed model usage

The production service exposes routing decisions and provider attempts through
authenticated conversation activity events. Calls carry a stable ID, owning run
ID, saved preference, requested reference, observed serving identity and reported
tokens. Existing VUH-2108 identity schemas and response-header rules are unchanged.
Requested aliases never prove the serving model. Saved provider preference bounds
eligible targets; ordinary catalog, credentials and existing credit rules remain.

## Integration evidence

`apps/clankie/test/turn-model-http.integration.test.ts` starts the real source
service in a scratch preset, with a private HOME, file credential broker, disabled
Herdr and isolated fleet resource state. Pi uses its ordinary OpenAI-compatible
HTTP transport against an owned streaming endpoint. Conversation dispatch,
settings selection, actual tools, metrics, durable journal and authentication run
through production code. The external provider responses are controlled fixtures;
this proves integration behavior, not cloud model quality, cloud billing or a
deployed hosted proxy. No paid provider calls or evals ran.

The retained receipt includes 121 conversation events and 14 completed provider
calls across seven turns, reporting 182 fixture tokens. Each run's call totals
and report count equal its authenticated turn metrics. The cases cover:

- Normal included call with serving-model response identity.
- A completed file read, followed by Clankie's escalation tool, with subsequent
  calls changing model in the same session. The read runs once and user messages
  are not replayed.
- A requested escalation whose observed hosted fallback differs from its alias.
- An unavailable target that keeps the current model; absent identity headers
  remain explicitly unknown.
- A saved provider change through the authenticated settings API. A retained
  included target cannot override the selected provider.
- Refusal of a second escalation in one turn, and next-turn saved-preference reset.
- Unauthenticated history refusal (401), and identical retained history after
  stopping and restarting only the owned service.

## Checks

Affected routing, settings, identity, conversation-tail, service-fallback, relay
and TUI checks: 280 tests across 15 files. Focused compiler coverage includes the production
Clankie graph and the changed test group, under the existing 2.5 GiB ceiling.
Touched-file formatter and lint pass through the deployed resource governor.
The integrator owns the final exact-tree landing gate; no duplicate root gate.

**Negative control:** temporarily removing the saved-provider fence makes the
HTTP regression fail: requests become `first, escalation` instead of
`first, first`. The fence was restored before the receipt and final checks.

**Missing observations:** the service-fallback regression delivers one worker
report on a legacy lane without route metadata. It publishes neither guessed
message identity nor per-call routing observations. Removing the recorder's
optional route access reproduces uncertain delivery; restoring it passes. This
uses VUH-2108's repaired identity boundary unchanged.

**Retained failures:** first checks found the erasable-syntax compiler restriction,
an invalid fixture option, outdated routing copy/shape assertions, and fixture
API/schema mistakes. The nonzero outputs remain in the issue's evidence archive,
alongside corrected results. They are not reported as green full gates.

## Open items

The catalog/provider and commercial credit decisions in VUH-1890 remain open.
VUH-2107 owns hosted charge IDs, charged amounts and policy changes; this slice
records observed models and reported usage without inventing ledger attribution.
VUH-2108's hosted identity deployment is separate. Older proxies without headers
continue to report unknown. VUH-2110 owns client presentation of these shared
events. The lead closes this issue only after its dependency and this slice land.
