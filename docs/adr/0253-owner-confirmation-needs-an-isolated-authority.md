# ADR 0253: Owner confirmation needs an isolated authority

Status: Proposed (2026-10-08), awaiting James's boundary and action-set decision
for [VUH-1687](https://linear.app/vuhlp/issue/VUH-1687). No protected signing
boundary has shipped. This proposal would amend [ADR 0130](0130-goals-and-self-wakes-share-the-operator-thread.md),
[ADR 0244](0244-machines-join-clankie-at-an-access-level.md) and
[ADR 0251](0251-discord-owners-and-room-skills.md) where their bearer-backed
settings are treated as exclusively human authority.

## Problem and threat model

Today the operator bearer is a broker credential and paired-device sessions use
a host-readable signing key. A shell running as the owner's OS user can resolve
that bearer, read local device keys and modify user-owned settings/state/code.
File mode 0600, a different Keychain service name, a prompt description or a
separate process under the same UID does not isolate those actions. The current
credential broker protects secret handling, not human presence for each call.

VUH-1831 distinguishes Discord owners, mixed audiences and bounded room skills.
VUH-1801 independently caps machine access at portal/workers/shell/screen. Those
are real service authorization checks, but a same-user shell can bypass mutable
local policy or obtain the owner credential. Becoming a Discord owner must not
become permission to mint human confirmation or raise a machine ceiling.

The attacker is a shell-capable model/worker with the owner's non-admin process
identity, its files and exportable Keychain credentials. No human confirmation,
admin authorization or kernel compromise is assumed. Protecting against root,
a compromised enrolled phone, or an owner approving the attack is outside this
boundary. An already-granted full shell can perform ordinary OS actions directly;
this proposal does not retrofit an OS sandbox or protect work-forge credentials.

## Recommended decision: protected authority plus local confirmation

Use a separately controlled authority for protected code, public-key enrollment,
replay state and the authoritative effects. On a self-hosted Mac, install signed,
non-agent-writable code and a narrow authority with a dedicated OS identity;
root is needed only for reviewed installation, not general model execution.
Agent code, models and workers remain outside that authority. Do not let the
helper load a user-writable checkout, libraries, environment, configuration or
arbitrary executable. Its typed operations must own validation and effects,
not return an approval boolean to a mutable agent-side gate.

For local human confirmation, use a non-exportable Secure Enclave P-256 key with
Keychain access control requiring user presence for each protected signature.
Keep key handles in Keychain/the broker's native protected adapter; never export
private material into JSON, environment variables, the generic-password store or
logs. A trusted signed confirmation surface displays the exact decoded action,
target and material parameters before signing. Authentication alone, or an
agent-controlled text label on a Touch ID prompt, is not informed consent.
Do not reuse an authentication context to silently approve another action.

Apple documents [Secure Enclave signing](https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing/privatekey)
and [P-256 key protection/access control](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave).
This requires an explicit P-256 algorithm/version extension; it cannot be passed
as an Ed25519 signature to the existing hosted-body verifier. Continue using
Ed25519 for its existing host/fleet role, without algorithm guessing or downgrade.
The separation follows Apple's [secure helper guidance](https://developer.apple.com/library/archive/documentation/Security/Conceptual/SecureCodingGuide/DesigningSecureHelpers/DesigningSecureHelpers.html):
helpers must validate typed requests and treat caller-writable files as untrusted.

The authority must own the protected state and enforce it at the effect. A
root-owned public-key file is insufficient while a same-user service can replace
the verifier, rewrite an active goal, mint a device grant or raise a machine's
stored ceiling. The installer design must trace every protected action's last
consumer: an untrusted settings mirror never becomes authoritative. Isolating
only the signer or only an HTTP middleware is not this design.

Hosted verification can use the separately controlled hosted authority; its
business/control-plane implementation belongs in clankie-ops. Joined hosts
retain their own VUH-1800 ceilings. A phone signer is a later alternative, not
a requirement for the local Mac path or a reason to weaken local verification.

## Initial protected action set for owner review

| Action                                                                                | Confirmation binds                                                           |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Set/accept/resume an active service goal; enable autonomy; increase its budget        | Conversation, exact objective, goal incarnation, budget and current revision |
| Expand machine access or worker directory/worktree-root authority                     | Machine, old/new ceiling, canonical workspace identity and revision          |
| Expand Discord owners or machine actor authority; add/expand a room capability        | Server/channel, exact owner policy or bounded grant and revision             |
| Issue/expand device, fleet or owner execution grants; answer an owner-only escalation | Intended principal, target, exact grants/action and current issuer binding   |
| Change which operations need confirmation or who can approve them                     | Exact old/new authority policy and revision                                  |
| Enroll/replace/recover a signer; disable protected mode                               | Existing authority epoch, new key/principal and recovery action              |

Reads, ordinary personality/worker defaults, inactive goal proposals, already
approved delegated work and social/skill turns remain available. Authenticated
stop/pause and authority-reducing revocation must remain available without a new
presence prompt. A replacement key needs the old protected signer or explicit
OS-authorized recovery; a stolen bearer/device token is never a recovery path.
Existing explicit delegation is not silently converted into per-tool prompting.

## Action protocol and effect

1. The authority constructs a bounded canonical challenge: schema/algorithm,
   authority installation and epoch, owner key ID, operation, target, all material
   parameters, expected state revision, fresh nonce and short expiry. Its own
   clock and durable nonce journal define validity; the caller cannot supply
   signing authority or extend expiry.
2. The trusted confirmation surface reads/displays that exact challenge and
   signs its domain-separated bytes after presence. Decline/cancel creates no
   approval. No reusable “owner present” bearer or session-wide signing grant.
3. The authority verifies its enrolled key, algorithm, exact bytes, nonce,
   revision, expiry and current grants. It atomically consumes the approval and
   commits the corresponding protected transition; concurrent requests and
   restart cannot replay it. Unknown/lost effect receipts reconcile by the same
   request ID and never re-execute blindly.
4. Every protected path uses that authority: API/CLI/TUI, device/relay, MCP,
   Discord, goals/self-wakes, enrollment, migration and recovery. Exportable
   operator/device credentials retain ordinary authentication only; they cannot
   replace the action proof. Unavailable authority fails closed for expansion;
   stop/revoke remains usable.

## Minimal owner setup and migration

One explicit enable action installs/registers the signed local authority and
creates/enrolls its hardware key. It explains the boundary and requests the
single required OS installation approval. Do not ask the owner to copy keys,
run account commands, choose ports or prepare a phone. No installer, privileged
service, OS account, Keychain item or live settings change is authorized by this
proposal's source landing. A Mac without the required hardware must report that
protected confirmation is unavailable; no automatic software-key fallback.

Upgrade keeps the current bearer-based mode until the owner opts in. That mode
must continue to say it does not resist a same-user shell. Once enabled, absence
of protected authority cannot restore bearer-only expansion. Existing grants
and active work need explicit migration semantics before enabling; protect their
future expansion while preserving stop and recovery. Installation/recovery and
mode removal remain owner-authorized operations.

## Alternatives and consequences

- Move the entire service/code/state/broker outside the agent UID: can isolate
  readable credentials, but alone provides no per-action human confirmation and
  disrupts native worker/tool setup. The recommended narrow authority still
  requires genuine OS separation at its effects.
- Use only a Secure Enclave signer: protects private-key export but leaves
  same-user verifier/state replacement and alternate bearer paths. Rejected.
- Use phone confirmation with an isolated verifier: viable but adds phone
  enrollment/availability. A same-user mutable verifier remains insufficient.
- Revive PR #18's global safety rules or harness prompt wrapping: does not create
  OS isolation and would duplicate working preferences. Not part of this work.

This is a security/install boundary, not a low-impact settings toggle. Keeping
owner setup short cannot remove the protected-state and trusted-effect work.
The accepted VUH-1831/1801 behavior stays unchanged until this design is accepted
and its native boundary is implemented and proven.

## Verification required before claiming VUH-1687 complete

Use an owned isolated deployment with a real distinct enforcement principal and
hardware signer. A separate hostile same-user process reads all permitted files
and broker items without printing them. It cannot activate goals, enlarge grants
or replace enrollment without confirmation. Verify bearer/device-key theft,
state/verifier replacement attempts, forged enrollment/recovery, algorithm
confusion, altered parameters/revision, expiry, concurrent duplicate requests,
restart replay and revocation while approval is pending. Confirm valid human
approval affects only its exact action once; decline, cancellation and unavailable
hardware do not fall back. Recheck ordinary reads/delegation and stop/revoke.

Disposable HTTP/broker integration tests of the current bearer boundary are
useful baseline evidence; they are not native protected-signing proof. No owner
criterion is checked solely from a software signer or same-UID helper fixture.

## Decision awaiting James

Approve the recommended isolated authority + Mac user-presence signer and the
initial protected set above, or select a different boundary/set. The earlier
[VUH-1687 decision thread](https://linear.app/vuhlp/issue/VUH-1687) expressly
requires this choice before implementation. After approval, implementation can
be staged without installing or changing owner credentials until the concrete
installer and protected-effect verification are reviewable.
