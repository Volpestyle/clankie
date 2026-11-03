# ADR 0353: Workers raise structured asks in their reports

Status: Proposed, 2026-11-03, for [#604](https://github.com/Volpestyle/clankie/issues/604).

## Context

A worker that needs a decision writes it as free text in a `message_clankie`
report, and its lead has to read the options out of the prose and rephrase them.
Nothing lists the decisions still waiting, no surface can show them as choices,
and an answer is an ordinary message with nothing tying it to the question.

Reports already have a durable path: each harness bridge keeps a local receipt
of the report text, the service fingerprints that text, and a retry or
reconciliation proves the exact original. Huddles (VUH-2025) already carry
structured worker answers inside that text as one JSON block.

## Decision

A worker raises an ask inside an ordinary report, as one JSON block:

```json
{
  "ask": {
    "question": "Push the fix to main now?",
    "options": [
      { "value": "push", "label": "Push now" },
      { "value": "wait", "label": "Wait for review" }
    ],
    "freeText": false,
    "confirms": "push"
  }
}
```

It has two to five options, each with the value the worker gets back and the
label a lead sees. `freeText` lets the lead answer in its own words. `confirms`
names the risky action (push, merge, restart, rotate, delete or release) when
the ask confirms one.

- **The report path carries it unchanged.** The text is still the report; its
  receipt, fingerprint, retries and routing are the same, so every harness can
  raise an ask with no bridge change. A report that carries an ask is heard at
  once, like a blocked one.
- **The service records it once.** When a report is accepted, the service
  parses the block (`workerAskIn` in `@clankie/protocol/worker-asks`) and keeps
  the ask, keyed by the report's delivery id, in `worker-asks.json`. The lead's
  copy of the report lists the options and the ask id.
- **Its lead answers it.** The ask belongs to the lead conversation the report
  reached. Clankie answers with `answer_worker_ask`. Any lead or surface with
  owner or Take Control authority uses `GET /v1/fleet/asks`,
  `POST /v1/fleet/asks/:askId/answer` or `…/withdraw`, and the CLI wraps them as
  `clankie asks`. An answer must be one of the option values, or free text when
  the ask allows it. Worker questions go to their lead; nothing routes one to
  the owner.
- **The answer reaches the worker tied to the ask.** It goes down the same seat
  lane a lead's message takes: "Your lead answered your ask ID ("question"):
  value (label)". The answer is saved before it is sent. Once it is delivered
  the ask is answered. If delivery definitely failed it is open again. If
  delivery is uncertain it stays `answering`, is never resent, and can only be
  withdrawn.
- **Asks stay listed until settled.** Open asks are listed until answered or
  withdrawn. Settled ones are kept, and the oldest settled ones are dropped
  first.

## Consequences

- Leads and apps can show an ask as a card and answer it with one tap; the app's
  card is built in the app on this API.
- A worker that writes malformed JSON sends an ordinary report: the lead still
  reads it, and nothing is lost.
- A joined native worker's report carries the block as text
  but raises no recorded ask yet, because its answers take the joined lane.
- The Needs James view can later read open asks; this change does not route any
  to the owner.
