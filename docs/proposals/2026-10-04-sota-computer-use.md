# Clankie's own computer-use loop

2026-10-04. Proposal for [VUH-1618](https://linear.app/vuhlp/issue/VUH-1618),
under [VUH-1617](https://linear.app/vuhlp/issue/VUH-1617), including the body seam
for [VUH-1619](https://linear.app/vuhlp/issue/VUH-1619). No comparison, inference
probe, app interaction or eval was run. This does not change the default or
accept [ADR 0199](../adr/0199-hard-computer-work-goes-to-a-computer-use-harness.md).

## Available today

Read-only inspection on James's Mac, against `origin/main` at `9f82ae5d`:

| Route              | Evidence and limit                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native Codex       | CLI 0.160.0, ChatGPT login, `computer_use` and `browser_use_external` enabled; `clankie browser harnesses` reports desktop and Chrome. Installed computer-use plugin 1.0.1001365 describes macOS apps. This proves configuration, not successful input or API-key entitlement.                                                                                           |
| Clankie's provider | `clankie model status` selects `openai-codex/gpt-6.1-sol`, xhigh. This is an observed selection, not model policy. The [OAuth route](../../packages/model-provider/src/oauth/openai-codex.ts) uses the legacy Codex backend. Pi 1.0.0 serializes ordinary function/custom tools and images; its Responses parser has no `computer_call`/`computer_call_output` handling. |
| Existing hands     | Peekaboo 4.3.0; TextEdit, Preview and Chrome installed. [Desktop control](../desktop-control.md) records capture/action and freshness gaps; installation does not resolve them.                                                                                                                                                                                          |

The installed app-server schema exposes thread/turn control, app-access policy
and image-returning dynamic tools, but no standalone computer-action RPC.
[App-server](https://learn.chatgpt.com/docs/app-server) runs a model/tool loop;
it is not a mouse API. Native computer use on an API-key account remains unproven.

The [OpenAI computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use)
supports client-executed code and the native `computer` tool. Code can group
actions and return observations through ordinary function tools. Public API
availability is not subscription entitlement: the separate published
[ChatGPT plan route](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
excludes native computer use. That restriction is not evidence about the legacy
backend. Do not add an unsupported tool to Clankie's OAuth requests or infer
access from a catalog. No entitlement request was attempted here.

## One activity, two execution routes

Make computer work an autonomous activity of the owning conversation, with its
goal, original authority, progress and final artifacts. Give it a compact working
context and continuous observe–act–verify loop; ordinary chat need not carry
every click. Keep Peekaboo as fallback. Select the model through owner settings
and the measured result, without hiring a worker or hardcoding a brand.

- **Native Codex:** reuse the [app-server client](../../apps/clankie/src/captain/codex-app-server.ts)
  and [conversation attachment](../adr/0218-native-seats-drive-their-attached-conversation.md).
  Clankie's own visible `clankie codex` view owns the conversation and its native
  computer tools. Use `thread/resume`, `turn/start`, events and `turn/interrupt`;
  retain thread/run identities and reply correlation. No `hire_agent`, hidden
  Codex child or second executor. A service-run conversation can hand over only
  through the existing admission fence. Preserve the owner's plugin/app grants.
- **Provider loop:** run inside the existing service execution, using its broker
  and selected computer-capable provider. Start with ordinary function tools
  exposing persistent, bounded UI code execution and screenshot results; this
  fits his `openai-codex` lane without claiming native-tool support. For a metered
  Responses provider supporting `computer`, add an adapter preserving ordered
  actions, reasoning items, call IDs, screenshot outputs and safety requests.
  This needs native-item support beyond Pi's current parser. Both forms continue
  until verified completion, a person-only step, cancellation or a run limit.

The common body contract supplies fresh screenshot IDs, dimensions and coordinate
mapping; app/window inventory; ordered input; receipts distinguishing confirmed,
failed and uncertain effects; and a single driver lease bound to body and
conversation. Reuse [environment lease/media conventions](../../packages/interactive-environment/README.md),
not its GBA command schema. Code receives scoped UI capabilities, not unrestricted
host shell access. Preserve images; the current generic MCP host returns text only.

Both routes keep ADR 0127's stops for sign-ins, codes, CAPTCHAs, payments and
destructive steps. UI text is untrusted. Revocation stops dispatch; transfer the
screen only after confirmed quiescence. Native interrupt/approval enforcement
needs live proof. An uncertain action or stop cannot be silently retried through
Peekaboo. The owner can watch and stop the activity.

## Hosted bodies

VUH-1619 supplies a persistent isolated desktop per customer through the same
capture/input/lease contract. Recommend a Linux desktop as the first candidate;
James decides OS and plan inclusion. Native Codex's Mac plugin is not a Linux
implementation, and Windows schema fields do not establish Windows readiness.
Use the provider loop with platform input adapters, persistent browser/app state
and live screen streaming to the app. This is a whole desktop, not just a browser.

Public Clankie owns that contract and runner. `clankie-ops` owns provisioning,
isolation, persistence, model provisioning, metering and plan policy. Use the
included-usage forwarder in private `clankie-ops/apps/body`, composed through
the public [runtime-provider boundary](../adr/0183-the-harness-is-public-the-hosted-service-is-private.md#amendment-optional-managed-runtime-composition-2026-10-05-vuh-1664).
Read-only inspection of the ops proxy finds OpenAI Responses behind pinned model
aliases, client tools (top-level functions), inline images and no stored-response
continuation. Code execution fits that contract; native `computer` tools are
currently filtered out. Ops must explicitly provision and meter a computer-capable
model route, and support native items before enabling that variant. Replay bounded
history and budget screenshots against the 2 MiB upstream request limit. Provider
keys stay in the proxy. The proxy also normalizes image `detail: original` to
`auto`; measure fidelity before claiming native-loop parity. This inspection
establishes code, not live deployment state.
[Hosted ChatGPT subscriptions are currently refused](../../packages/model-provider/src/subscription-policy.ts);
included usage must work without the customer's Codex plan. Clankie's accounts
remain his; customer credentials enter only through the customer's own sign-in.

## Fixed manual comparison

Implement an explicitly invoked harness under `scripts/manual/`, excluded from
CI and `pnpm check`. James starts it. Freeze a fixture manifest, prompts, app
versions, display geometry, model/effort, tool permissions and reset snapshots
before any run. Use disposable local files and a localhost fixture site; no
personal accounts or real transactions. All solutions must act through UI tools;
only the independent grader reads fixture state directly.

| ID  | Fixed task                                                                                             | Independent success check                                  |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| N1  | TextEdit: replace the second occurrence of `blue` in a 12-line file; save a new plain-text copy.       | Exact expected UTF-8 bytes; original unchanged.            |
| N2  | TextEdit: make a rich-text note with a bold heading and three supplied bullets.                        | RTF text and heading formatting.                           |
| N3  | Preview: export pages 2–3 from a supplied four-page PDF.                                               | Two pages with expected text and order.                    |
| N4  | Finder: create `Delivery` and copy three named files from two folders.                                 | Exact destination manifest and hashes; originals retained. |
| B1  | SPA: select two filters through a delayed modal and save the matching item.                            | Fixture's selected IDs and saved record.                   |
| B2  | Upload the supplied CSV through a file picker, then download its generated report.                     | Upload hash and report contents.                           |
| B3  | Canvas board: drag three cards into a specified order.                                                 | Fixture's recorded order.                                  |
| B4  | Navigate two tabs to collect values and enter their sum in a form with one validation error to repair. | Exact final form record.                                   |

Compare at least (A) current Peekaboo in the captain turn loop, (B) native Codex
computer use in Clankie's own view, and (C) the provider computer-use loop. Freeze
which code/native variant C uses; report additional variants separately. Run each
task three times from a reset, rotating arm order, with a ten-minute/150-tool-call
ceiling. Record successes/total, unavailable runs, primitive inputs, model/tool
calls, wall time including startup, interventions and usage/cost. A batch is not
one click; unavailable native input counts stay explicitly unknown.

Add fixed boundary fixtures in the complete local test app: sign-in/payment/
destructive controls, UI
prompt injection, and lease revocation during an action batch. Correct refusal
and quiescence are required; these are separate from task success. Archive prompts,
configuration, timestamps, receipts, screenshots and grader results. Prefer the
highest verified success among routes available under the intended host/auth;
use latency and cost to break ties. Record the chosen defaults and why, including
Mac without a Codex plan and hosted included usage. A native-only win cannot prove
either. Then update desktop docs/skills and accept or supersede ADR 0199.
