# Owner credential recovery — VUH-1807

Owner-typed Pi turns now continue once after a successful forced OAuth refresh,
inside the original run. Pi's native pre-settlement boundary commits a context
edit omitting the rejected assistant response, then continues from the original
owner input. The failed record stays in append-only audit history. Successful
recovery adds neither a duplicate owner input nor a failed conversation turn.
Attachments and completed tools remain in context and are not replayed.

The prompt-owning invocation reserves recovery; a steering caller cannot replace
it. Refresh and continuation keep the original lane and receipt pending. Failed
refresh, a second credential rejection, cancellation or loss of that reservation
prevents continuation. The second rejection records repair state without another
forced refresh. Existing self-wake recovery remains separate.

Hosted provider credentials are service-operator managed. Rejection records
`operator_required`, emits a content-free operator diagnostic, and follows the
existing failed-turn telemetry path. Customer replies and doctor guidance never
ask for `/auth`, including when that instruction appears in an upstream error.
Local reconnect guidance is unchanged. No dedicated control-plane credential
escalation endpoint or acknowledgment is claimed.

## Verification

The covering fixture uses a real Pi session, a file credential broker, local HTTP
model and OAuth endpoints, a persisted conversation journal and real attachment
storage/tool execution. All seven cases passed in 2.70 seconds: successful
refresh, revoked refresh, second rejection, completed tools before rejection,
cancellation, concurrent owner steering and consecutive-owner control handoff.
The handoff fixture holds the old turn's final log write while the next turn
refreshes, proving that delayed cleanup cannot erase its recovery reservation.
Pi's automatic retries are disabled in this fixture.

Nine focused hosted guidance, doctor and existing self-wake recovery checks also
passed in 2.757 seconds. The name filter excluded 25 unrelated tests in those
files; it did not change their coverage or skip declarations. Scoped formatting
passed on all 16 changed files. Receipts are retained in ignored `.local/`.

After rebasing onto `d20aac2d`, `pnpm check:landing` passed through `clankie heavy`:
all 29 workspace typechecks; bundled skill, formatting, lint, deadcode and doc
checks; and 202 affected test files with 1,591 passing tests and one existing
skip. The affected tests took 188.99 seconds. No skip declarations were added.
The landing gate also caught exception-parameter reassignment and a missing
model reference in the new fixture; both were corrected before the clean run.

The initial fixture exposed an incorrect assumption about Pi's projected entry
shape; recovery now reads the projection's source entry. Review also caught the
consecutive-owner cleanup race, which the seventh fixture reproduces. Subsequent
fixture corrections use a valid repository image, capture results at admission,
and check the resolved projection rather than raw audit entries.

This is local integration evidence, not a refresh against OpenAI. No live
credentials, paid probes, evals, deploys or service restarts are used. VUH-1807's
live provider acceptance remains open for the next real deployed turn.
