# Worker receipt baseline

The owner assigned the `worker-call-receipts.integration.test.ts:333` baseline
failure. The separate subscription expiry classification fix belongs to Juno
and VUH-1811; this change does not edit that path.

Wren observed a structured `refused` response without a receipt under the
four-worker landing selection, while the isolated file passed 15 tests. His
original assertion omitted `reason` and `detail`, so its exact refusal stage
cannot be recovered from that diff. The caller's 3-second fetch deadline would
reject the HTTP request rather than return that structured tool response.
His later unmodified clean-main run at `3407a76a` passed 453 files and 4,148 tests
(31 skipped) with four workers and only the separately owned subscription file
excluded. The historical refusal therefore remains intermittent and its exact
cause remains unconfirmed; that run is not evidence for excluding receipt tests.

The fresh worktree started at fetched main `3407a76a`. A controlled trace held
the existing loopback GraphQL provider's read response for 600 ms with the
original fixture's 500 ms worker deadline. The provider observed `TrackerRead`;
the worker returned `server_unavailable`, with
`MCP linear/get_issue timed out after 490ms`, without a receipt. Elapsed time at
the assertion was 619 ms. The remaining 14 tests passed. This proves a fixture
defect: an ordinary receipt-scoping test unintentionally imposes the expiry
tests' latency limit. It does not prove which timer won in Wren's historical
suite run. No production deadline or receipt behavior changes.

The fixture now leaves ordinary requests on production worker deadlines and
uses the existing Vitest lifetime bound instead of a second HTTP deadline.
Seven intentional expiry cases explicitly retain the 500 ms worker budget;
the receiving-HTTP cancellation case still supplies its own AbortSignal.
Late settlement, account binding, kill-switch checks, concurrent duplicate
prevention and the expired pre-dispatch fence remain asserted.

The receipt-scoping case now holds one real provider response for 3.1 seconds,
past both former fixture-only limits, then checks successful receipt replay
without another provider call. The first corrected-fixture run, with the
600 ms hold, passed 15/15. Final landing checks cover the 3.1-second regression.
All commands run through `clankie heavy`; no live provider, simulator, eval or
existing lane is used for this proof.

Final verification passed: the landing gate and all four related worker
integration files, with the normal four-worker configuration. The gate includes
formatting, lint, dead-code and documentation checks, workspace typechecks and
affected tests. No test exclusions or retries were used.
