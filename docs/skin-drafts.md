# Owner key-pose drafts

The service can keep an owner's brief and already-owned reference/key-pose
images as a durable draft. Generation can join the configured media seam to that
same draft through a durable request journal. **Paid generation remains closed**
until the host has an approved credit-admission policy; neither a request nor a
pose approval enables spending. Animation, independent visual review, catalog
publication and live selection remain separate. A pose approval is not
publication approval. The private app's draft review uses this same owner API.

## Prepare and approve

1. Upload owned PNG/JPEG images through the conversation attachment API. Only
   committed owner attachments (or their preserved copies in the same draft) are accepted; delivered worker files, local paths,
   arbitrary URLs and executable recipes are refused.
2. Create a draft with `clankie skin draft create 'A ninja warrior unicorn'
--request UUID`. Keep that UUID: replaying the same create intent returns its
   current draft, including after restart or a lost reply. A different intent
   with the same UUID conflicts. `list` and `get ID [--version N]` reconcile
   state without retrying an edit.
3. Import `rest` first with `clankie skin draft pose COMMAND.json`, then `work`
   and `comms`. Each command names the draft's exact revision, a committed
   attachment and an explicit sampling grid:

   ```json
   {
     "action": "pose",
     "draftId": "UUID",
     "expectedRevision": "SHA256",
     "pose": "rest",
     "source": { "conversationId": "CONVERSATION", "artifactId": "ARTIFACT" },
     "sampling": { "grid": { "pitch": 1, "columns": 32, "rows": 64 }, "colors": 16 }
   }
   ```

   Correct the pitch/origin from the reference; don't resize a tall character
   into a shorter grid. Cells are at most 32×96. Work/comms must match rest's
   native geometry and use its palette. Replacing rest clears both other poses.

4. Inspect each source and native pose side by side, with Classic as the visual
   comparison baseline. Use the exact-revision preview routes below. Compare
   native proportions, distinctive features and color identity. The API returns
   review data and images; it does not claim that a person viewed them.
5. The owner chooses `clankie skin draft approve ID REVISION` or `decline ID
REVISION`. Approval records the authenticated principal, input revision and
   all three native image digests after rechecking their original/native bytes.
   Agents can prepare/edit/cancel via `skin_draft` in a proven owner conversation;
   that tool cannot approve or decline, including a forged direct execute call.
6. `revise ID REVISION 'Updated brief'` or replacing any pose clears approval.
   A declined draft can be revised. `cancel ID REVISION` is terminal. Only the
   exact approved revision may become a later animation stage's input, which
   must verify the stored hashes again and retain owner approval provenance.

The owner's existing bearer/device authority is revalidated during operations
and before committing changes. Social and worker turns do not receive that
owner authority. Drafts are namespaced by the host-selected owner account;
request/model inputs cannot choose an owner namespace. The service stores private
copies of original and sampled images, so attachment retention cannot silently
change the approved input. Draft metadata and history use private permissions,
revision hashes and an atomic current-record commit marker. A staged but
uncommitted history version is unreadable. There are at most 128 drafts per owner
and 64 revisions per draft; limits fail explicitly rather than discard history.

## API contract

`@clankie/protocol/skin-drafts` publishes the strict command and response schemas.
All these routes require owner operator credentials or an eligible paired
owner device with terminal control. Responses and image previews are private,
non-cacheable. The device projection allows only these exact paths/queries.

| Route                                                                 | Result                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /v1/operator/skin-drafts`                                        | `{outcome:"list",drafts:[...]}`                                   |
| `POST /v1/operator/skin-drafts`                                       | Strict create/list/get/pose/revise/approve/decline/cancel command |
| `GET /v1/operator/skin-drafts/UUID?version=N`                         | Current draft if version omitted, otherwise committed history     |
| `GET /v1/operator/skin-drafts/UUID/reference?revision=SHA256`         | Preserved original draft reference                                |
| `GET /v1/operator/skin-drafts/UUID/poses/ROLE/source?revision=SHA256` | Original owned PNG/JPEG                                           |
| `GET /v1/operator/skin-drafts/UUID/poses/ROLE/native?revision=SHA256` | Sampled native PNG                                                |

`ROLE` is rest/work/comms. Image responses include `x-clankie-sha256`. Mutation
commands except create require `draftId` and `expectedRevision`. A stale revision,
changed artifact, cancelled edit, conflicting request UUID or incomplete approval
returns 409. Missing owner proof/authority, unknown drafts/references, invalid
input and exceeded limits fail closed. An uncertain edit is reconciled with
`get`, never automatically replayed. No field can select a provider, model,
budget, publication or live setting change.

## Generation journal and admission

`clankie skin draft generate ID REVISION --request UUID` (API/tool action
`generate`) uses the brief already stored on that revision. It returns
`skin_generation_credit_policy_required` without changing the draft or making a
provider call when host admission is closed. Production currently always closes
this policy; there is no environment variable, model field or UI switch to open
it. Local integration fixtures explicitly admit only their loopback provider.

When admitted, generation requests rest, work and comms in sequence, using the
authorized draft reference (or retained prior rest source) for rest and the new
rest source for the other poses. The configured media adapter supplies provider
and model. Native sampling preserves the source aspect ratio, with work/comms
using rest's dimensions and palette. The source and native bytes stay in the
owner's private blob store. Generated pose sources use
`{generationRequestId,pose}` instead of pretending to be conversation uploads;
that same reference can be used by `pose` to correct sampling.

The draft keeps up to 16 generation journals within its existing 64-revision
limit and a 256 KiB record bound. Every individual dispatch is atomically saved
as `dispatching` before the media call. Completed steps retain the exact media
result (including the provider request ID when supplied) and source digest.
Reusing a request UUID with its original input revision returns its saved result;
it does not draw again. A different revision with the same UUID conflicts.

An interrupted dispatch becomes `uncertain` when reconciled with the original
generate request. It is never replayed, and another generation is refused while
that uncertainty remains. There is deliberately no claim that a provider failure
response proves no charge: ambiguous refusals such as `provider_failed` are
retained as `uncertain`, and automatic work stops. Only known pre-dispatch
refusals (missing model/credentials, unsupported provider or denied authority)
are final refusals. A killed service can leave a `running` journal visible to `get`;
reading does not dispatch work. No automatic provider recovery or spend follows
a reconnect. Provider-side reconciliation and approved credit admission remain
required before production generation can open.

Owner edits and cancellation remain available while media is pending. A late
receipt is retained but cannot overwrite the newer draft. Any generated pose or
brief edit invalidates approval. The result stops at `awaiting_approval`; only
the direct authenticated owner operation can approve the exact revision.

The app shows originals, native rest/work/comms and Classic at equal native
scale, with description and sampling edits, approval, changes requested and
cancellation. An unconfirmed write requires an explicit refresh before further
editing or approval. Private previews are read through the authenticated device
transport and removed from the review when the connection changes. This is
review of draft poses, not ready-pack selection or hosted/physical-device proof.

The public repository contains only the generic contract, service and deterministic
tools. Actual owner art and reference-derived palettes belong in private owner
storage. The [compiler](../packages/lead-skin/README.md) remains usable offline;
its mechanical validation never substitutes for owner or visual approval.
