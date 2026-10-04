# Project proposal and explicit owner CREATE foundation

This dated implementation record describes the VUH-1538 public service/CLI
foundation. It is not proof that world onboarding is complete or deployed.
The app's explicit configuration review/confirmation and station integration,
tracker backend setup, and live conversational acceptance remain separate work.
No native agent, model, provider, owner settings or remote service was used to
validate this slice.

An original owner workspace turn may use `propose_project_create` to propose a
new project. Clankie chooses the questions and words. Repository explanations
are untrusted context; the service derives the canonical local workspace and
settings revision. The tool persists an immutable, bounded project artifact in
the existing question record. It cannot create a project. Existing preference
choices, text answers, and a reply saying “Create” remain nonwriting.

The original owner can inspect the proposal and explicitly confirm its exact
configuration through the same owner-authorized conversation API:

```text
clankie conversations project-proposal CONVERSATION --request REQUEST_UUID --incarnation INCARNATION_UUID
clankie conversations confirm-project CONVERSATION --request REQUEST_UUID --incarnation INCARNATION_UUID --revision REVISION --proposal PROPOSAL_UUID --artifact ARTIFACT_SHA256 --projects-revision SETTINGS_SHA256
```

The first command returns the complete command, resulting project, inherited
role policy, immutable target/hash and receipt state. Copy the exact reviewed
target into confirmation. Neither command silently selects a replacement or
retries a lost response. The corresponding opt-in operations are
`project_proposal_get` and `project_proposal_confirm`; existing strict preference
question DTOs are unchanged. Signed relay routing forwards the original device
identity and requires Take Control. Another paired owner, a chat-only device,
or a Clankie execution token cannot confirm the original owner's artifact.

Roles/model/effort are proposed configuration, not assignments or hires. Zero
caps remain zero; explicit null removes an override. Fleet size/model vocabulary
is a preference independent of numeric limits. An existing canonical, valid
`.clankie/tracking.json` can be bound; missing or changed tracker evidence cannot
be replaced with an inferred backend. This path grants no tools, accounts,
process authority, remote enrollment or worktree-root registration.

## Consumption and uncertainty

| State      | Meaning                                                                                               | Exact repeat confirmation                                    |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| pending    | Immutable proposal still needs live original issuer authority and current question/workspace/settings | May attempt the single guarded CREATE after fresh validation |
| committing | Durable consumed claim; not a guarantee work is still running                                         | Receipt only; never retry                                    |
| created    | Settings mutation returned success and a receipt was persisted                                        | Receipt only                                                 |
| uncertain  | A claim, settings or receipt boundary was interrupted                                                 | Receipt only; inspect/reconcile separately                   |
| refused    | The target/current authority is unavailable or mismatched                                             | No mutation                                                  |

Pending mutation needs the live original issuer closure, including its original
Request/JWT. A fresh token for the same principal does not renew that captured
token. Consumed receipts instead require fresh same-original-principal
credentials and the exact artifact target; they do not require a deleted issuer
closure. Restart cannot reconstruct a pending mutation capability. No settings
read, matching-byte comparison, or second CREATE is performed to reconcile a
consumed receipt. A missing/pruned/replaced record is unavailable.

The synchronous claim fences generic answer, user cancel and replacement both
after authorization waits and at the mutation boundary. Internal revocation,
context loss and reset can still invalidate the final guard. Late results cannot
overwrite a canceled question or a new incarnation. Claim-write errors consume
uncertainty: a throwing rename does not prove that its OS effect did not happen.
An uncertain initial artifact write also retains its in-memory question slot;
no issuer closure is installed after that failed write. If the old pending
record survives a failed write, a cold service still lacks its
issuer closure and cannot retry it.

The existing CREATE implementation is shared with the direct owner route.
Canonical directory/tracker identity, tracker content, settings and original
question authority are checked around awaits and the existing commit guard.
Settings rename and conversation receipt are not one transaction; the settings
store serializes its own instance, not other processes. Snapshot-to-rename and
post-commit revocation cannot be advertised as rollback or cross-process CAS.
A known settings result can become uncertain when its receipt/context is lost.
The immutable artifact hash excludes claim, status and receipt fields.

## Deterministic checks

Temporary directories/settings stores and actual temporary device signers cover
original-principal authorization, old-token expiry, direct/hosted signed relay,
claim races, generic preference nonwrites, target swapping, canonical directory
replacement, revocation/reset during awaited guards, unknown rename boundaries,
post-settings errors, failed receipts, cold reconciliation and no replay. The
CLI and protocol fixtures cover exact targets, strict fields and no transport
retry. Existing direct CREATE and preference-question regressions are retained.
These fixtures establish service behavior, not model phrasing or native world
acceptance. Existing human/agent reference updates remain separately coordinated.
