# LOCAL-VUH-11: lead closure without owner verification

Tracks: clankie-work://local/issue/4565b174-e485-439d-87e0-71030da7d61f

Candidate base: fetched `origin/main` `7e88a27aa9c066fed212bf2ce233b22546301282`.
Owned checkout: `/Users/james/dev/clankie-local-vuh-11`.
Native admission cwd remains `/Users/james/dev/tracker-research-20261008`.
Exact builtin project: `cbd205ab-cad4-48b8-9724-7109410fc921` (Clankie Work).

The candidate separates Done from human verification. A current scoped lead
under the owner's effective lead-closure policy may close landed work with a
current independently checked acceptance bundle. Done retains `landed` or
`delivered` and records `leadCompletion`; it creates no `verified` event.
Verification and reopening remain owner-only. Completion bundles stay locked,
and subsequent release delivery preserves Done. The owner loop skips new
automatic verification asks only for a uniquely bound project with legitimate
lead policy and an eligible owning route; existing asks and explicit gates remain.

## Scope and trust

Original authenticated native `clankie_tools`/`clankie_call` reads omitted repo:
`me` receipt `a9043056-f77c-4269-b57f-6e77ae37e54a`, exact issue receipt
`071358cd-a8c2-4d82-ac6b-b7299ad40581`, and exact project receipt
`492f7bdb-099f-4b4b-b7f5-aaa9b9a148a7`. The local-owner display is backend
metadata, not owner authority. The original run receipt links the confirmed
native seat `term_65db03e349d3343`, pane `w4M:p9`, to this exact issue.
No CLI, independent connector or owner identity substituted for these reads.
GLOBAL cleared all six shared caller/resolver paths before their edits.
`work-items.ts` needed no edit: its existing callback propagation carries the
new host-only capability. `index.ts` changes only closure wiring.

Closure authority originates from the original nondelegated operator turn's
`ConversationAuthority`, refreshed against current source authority, unique
registered tracker binding, effective owner-authored policy and private owning
conversation route. Final synchronous fences surround publication. Model role,
title, actor display, project arguments and inherited worker attribution grant
no capability. Project reassignment and closure in the same write are refused.

**Retained LOCAL-VUH-4 limitation:** the production `/v1/mcp` route accepts an
operator bearer and caller-selected existing conversation. A same-user worker
holding that bearer can select the owning chat. This proof establishes the
production scoped conversation route, not protected native lead authentication
or isolation from shared-bearer holders. The ordinary CLI and manual-grant
worker refusals describe those specific routes. Owner credentials, answers,
accounts, evals and physical-owner gates are not relaxed by this change.

## Verification

`production-results.json` contains the actual source service API/CLI readbacks
in disposable stores with generated scratch credentials. No live owner endpoint,
credential, preference, binding, autonomy, ledger or issue Done was changed.
The scratch service used one generated `scratch-stack.mjs` preset and the
governed server lane; fixture resource state was isolated with `NODE_ENV=test`
and `VITEST=true`. No model/provider credential or mock was used.

Observed production behavior:

- The scoped lead published evidence bundles through Captain MCP. A distinct
  authenticated manual-grant reviewer checked them through worker MCP. Done
  read back with `stage: landed`, the checked bundle ID and lead provenance.
- Worker, ordinary source CLI, wrong/default conversation, owner-closure
  policy, missing/duplicate binding and revoked settings scope refused Done.
  Missing evidence, unchecked evidence and unlanded work also refused it.
- Lead and manual-grant worker requests for `owner-verified` were refused.
  Closing the original scratch conversation made its cached MCP route return
  404; the item remained unchanged.
- Existing decision/verification ask IDs were preserved. Lead closure generated
  no new automatic verification ask.

The production setup seeds delivery/evidence fixtures using the real tracker
and EvidenceStore; this does not prove a real git landing. Manual worker grants
are actual production grants in scratch state, not native fleet admission.
The final production packet has 43 rows and `passed: true`. Its first product
probe exited 1 solely because an assertion expected outer `isError` for a
definitive nested refusal. The continuation inspected that original refusal,
proved conversation revocation, and exited 0 without repeating successful writes.
Earlier setup failures (evidence key length, SDK import, and the wrong generated
credential role for conversation creation) are retained separately. None is
presented as a product pass or silently retried after uncertainty.
The archived `production-probe.ts.txt` is the final corrected probe source;
`production-probe-attempt3.json` retains the original execution results. The
continuation script records the corrected interpretation without replaying writes.
The first two CLI attempts returned `not_found`: the fixture's absent nested
Git root made absolute `--repo` resolve to the enclosing source checkout in the
private scratch registry. They did not test closure authority or enroll anything
live. Initializing the disposable Git fixture fixed that lookup. The actual
source launcher then ran `work close LOCAL-10 --repo <bound scratch repo>` and
exited 1 with `owner_verification_required`; readback remained In Review / landed
with no lead completion. The bounded correction probe exited 0. Earlier lookup
failures and the original uploaded 39-row packet remain retained as provenance.

Eight persistent core regressions use explicitly labeled host-authority and
synthetic owner fixtures with the real EvidenceStore. They cover current bundle,
landing, independence, scope, revocation, project reassignment, atomic publication,
Done persistence, release advancement and owner backend compatibility. They
are not production authentication proof. Five focused integration files passed
32 tests. Package and app typechecks passed; explicit changed-file fmt and lint
passed. `checks.json` and `typechecks.json` retain the commands and reports.

Ordinary owner transport positives reuse unchanged-input baseline evidence:
[LOCAL-VUH-4 scratch terminal/app verification](clankie://evidence/sha256/e16224706be1ab79f487a38527738c6f3f09fa696a7a89f2be361c9b7aae3104).
The owner API/CLI authenticator and owner answer transport are unchanged. This
task performed no owner endpoint call or ask answer. Reuse establishes retained
ordinary workflow behavior, not human presence or protected owner authority.

## Harvest boundary

Native `gpt-6.1-sol` high independent review accepted the final diff, hashes,
actual production packet and relevant caller inputs before commit. The native
issue bundle must also receive its separate check from a distinct authenticated
actor; the native reviewer inherits this implementation worker's bridge identity.
Candidate/source proof is not
installed-runtime proof. GLOBAL owns the exact-tree root landing gate, integration,
push and deployment; this worker submits no integration run or push. No source
owner checkout, worktree enrollment, live machine grant/config, unrelated pane,
account or credential was altered. Owned scratch processes are stopped after proof.

Only this README and `evidence.json` are committed from the evidence folder.
Raw captures, source hashes, scripts and compiler reports belong in the evidence
store. Protected owner authority, installed closure proof and GLOBAL landing
remain outside this candidate's demonstrated acceptance.

Packet: [complete captures and review](clankie://evidence/sha256/1d2111c88912cb87b7065f1249e849ba3ab1a2aae91117cee42c75797ed11469).
Results: [43 production capture rows](clankie://evidence/sha256/54618d46b5be228fc9e6700d37a83777e6ae761928bafba821f62107659ae92b).
Native issue bundle: `c944ee5f-1edd-4ae4-aecd-9276c7602cf9`.
The final upload has two applied receipts and verified records; its nonzero exit
reported a local mirror collision with the retained earlier 39-row results.
Those earlier bytes were preserved separately and the local collision resolved
without repeating the upload.
