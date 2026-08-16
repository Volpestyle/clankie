# packages/api-client/src/index.ts

`ClankieApiClient`: fetch-based client for the
clankie service API. Constructor takes a base URL
or `{baseUrl, fetchImpl?, runnerToken?, runnerId?,
captainToken?, operatorToken?}`; each method picks
the header set its route needs and throws before
the request when the matching token is absent.

Route groups:

- Health/readiness — `getHealth` (fills a missing
  `profileHash` with "unversioned"),
  `inspectDiscordReadiness`.
- Captain lane — presence reports, bounded
  Discord channel turns, presence actions (which
  also stamp the bridge's live-session claim
  headers and surface error-shaped refusal
  bodies), phase events, presence-session and
  voice-history reads, the voice briefing
  (ids-only request; service composes persona).
- Memory — person-memory proposals/recall
  (captain), export/delete (operator), captain
  episodes record/recall (lane comes from the
  service-stamped channel, never the model).
- Embodiment — submit intents, session reads,
  the single live session, body possession
  (`undefined` = nobody), activity observation;
  runner-side `claimEmbodiment` /
  `reportEmbodiment` both carry 10 s
  `AbortSignal.timeout`s so a hung request can't
  wedge the claim loop across a service restart.
- Browser + media — `listBrowserTools`,
  `callBrowserTool` (refusals are results, not
  errors), `generateImage`, `generateVideo`
  (`pending` resumes by requestId).

All request/response bodies are parsed with
protocol schemas; auth helpers are
`runnerHeaders` / `captainHeaders` /
`operatorHeaders` / `activityReadHeaders`
(captain-or-operator).
