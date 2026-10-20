# Machine access

A device is where the owner talks to Clankie. A machine is where he acts.
Use `clankie machines --json` to read each machine's `accessLevel` and
`accessEnforcement`. Owners choose one cumulative level:

| Level   | Available work                                                     |
| ------- | ------------------------------------------------------------------ |
| portal  | Talk to Clankie; no native worker, general shell or screen effects |
| workers | Hire and control native workers within their approved workspaces   |
| shell   | General shell and filesystem tools, plus workers                   |
| screen  | Desktop capture/input, plus shell and workers                      |

Set a level through the authenticated owner API with
`clankie machines access NAME portal|workers|shell|screen`, or through
Settings → Machines / `/machines`. Existing local installs default to screen;
new or ungranted remote machines default to portal. Never infer a machine
level from its name, an SSH connection, a Discord owner or a room skill grant.
Machine permission and who may ask are independent checks. A bounded service
adapter doing its own I/O is not a grant of the caller's general shell.

The API is `PATCH /v1/machines/:id/access` with `{ "accessLevel": "workers" }`.
The paired-device command is `set_machine_access` with `id` and `accessLevel`.
Workers and joined clients cannot raise their own level. Joined receivers pin
the original approved ceiling and directories; lowering/restoring access within
that ceiling is live, but raising it further requires a new join approval. Unknown machines,
invalid levels and unavailable policy refuse. Native coding tools recheck
policy on each call, owner-pane polls require shell before and after waits,
worker launches recheck after waits, and screen input
rechecks before each effect. Recovery remains available after revocation.
Lowering a level does not terminate existing workers or undo completed work.

Ordinary local/SSH enforcement is reported as `service-preference`: the service checks
its own tools but runs under the owner's account. Do not call this an OS
sandbox. Approved join registrations report `joined-host`: the public receiver
checks access and canonical working-directory intersection, but live gateway
proof and native worker/screen adapters remain open gaps. An authorized shell
still runs as the owner; its file effects are not confined by the working-directory
check. A prepared installed macOS launch reports `os-sandbox` only after a
refused outside read. Inventory names its immutable `accessCeiling` and
`approvedDirectories`. The private home and workspaces are writable; installed
runtime/exact loader dependencies and OS support files are read-only. Metadata
and TCP networking remain available; this is not network or remote-service isolation.
It excludes owner Keychain/login files and outside Unix sockets. Native workers
inherit it through a fresh private bundled Herdr, never an adopted/external daemon.
Credentials, harnesses in the private home's `bin`, and required resource grants
need owner provisioning; unavailable resources refuse rather than fall back.

Owner setup: `clankie machines sandbox prepare portal|workers|shell --workspace DIR`
with repeated `--workspace DIR` and optional short `--home DIR`; `sandbox status`
reads next-launch controls only. It never changes a running service or confines
existing workers. Owner stop/start activates it. To raise back to full, the owner
stops the service, runs `clankie machines sandbox remove` outside the sandbox,
then starts it again. No reinstall or workspace/home deletion is needed. A
bounded worker cannot remove its controls or raise the OS ceiling. A changed
installed runtime needs owner re-preparation. Do not activate/restart or provision
live credentials without owner authority. Live lower/hire/refusal and restore
proof remain an owner-held gap. Apple's deprecated `sandbox-exec` is
the process boundary; do not describe it as a signed App Sandbox app or VM.

## Joined machines

A joined receiver
must check its own owner-approved level and directory grants before executing
worker, shell or screen requests, regardless of what the sender claims.

Use `clankie join --gateway URL --host HOST_ID --directory PATH` on the joining
host. From an existing authenticated owner CLI/device approve its code with
`clankie join approve CODE --access LEVEL --directory PATH`. The code expires
in five minutes. It is generated locally with 256 bits of entropy; bootstrap
advertises only its hash. Copy it only to the existing trusted owner approval
surface; never record it in evidence. Keep the join command running; it
reconnects by itself after a home restart or network loss. Revocation ends it;
a home that never returns leaves it retrying after one stderr notice. `join resume` restores approval;
`join status` is local registration status, not a live connection assertion.
`join leave` or `machines remove join-UUID` revokes it durably. At `shell` or
`screen`, `joined_machine_shell` runs your own command there (owner console,
owner-started turns only; autonomous turns are refused;
it starts in an approved folder; 30 s; 8192 characters; the first line is its exit;
everything the command started stops when it ends or is revoked). Each call is audited for the owner
(`machines shell-audit`). A lost delivery is never re-run, so check state before
repeating an effect. A new join needs
new owner approval. Lease and machine exchanges are authenticated AES-256-GCM
envelopes with one-use challenges and independently keyed responses. The
gateway cannot read or forge work or broker capabilities. Never print or copy
its broker capability into evidence.
The gateway's machine routes require separate clankie-ops delivery; do not claim
production readiness from the loopback integration fixture.

On a joined install, Clankie's service, memory and accounts stay at the home.
`clankie join status` reads its registration and `join resume` restores the
outbound machine channel. `clankie claude [--new | --conversation ID | --resume … |
--reset]` in an approved folder opens a local seat in the home's workspace chat:
plain `clankie claude` reuses that machine/folder's chat, `--new` makes another,
and exact conversation IDs must belong to that machine and folder. The home
supplies delegated lead tools and maximum trust through encrypted join traffic;
no SSH or second local service is needed. Resume keeps the native session and
chat in its original approved folder. Reset keeps the folder chat, retires old
sessions and reports earlier launches without closing their panes. The joined
lead hires native Claude workers through the running join channel; they report
with `message_clankie` using one UUID deliveryId per report, then reconcile with
`message_clankie_status` after uncertainty. The lead uses `worker_reports`,
`acknowledge_worker_reports` and `message_seat` to the returned seat. Run service
start/restart/recover at the home; a joined install refuses them locally. If
access is revoked, the lease is erased and local commands retain that specific
refusal. Use `clankie join leave` to forget it, or join again with fresh owner
approval.

## Lent screens

For a lent screen, use the same `clankie computer request` API with an explicit
registered `machineId: "join-UUID"`. Screen level does not grant local session
consent or input. The host asks its owner and shows a pet with Stop; observation
is the default. Desktop parents can supervise `join resume --json` with local
`screen_status` / `screen_stop` stdin controls; neither can enable input.
An unavailable or held Stop is not quiescence proof. Native accessibility
press/text and bounded navigation key/drag/scroll require exact receipts; no
fallback or replay. Native observer acknowledgments do not prove queue drain:
after any attempted input, Stop keeps the lease held. Read the
[desktop-control skill](../../desktop-control/SKILL.md) before driving, and the
[CLI contract](../../../../docs/cli.md#lent-computer-selection).

## Existing SSH machines

Existing SSH machines with a saved enabled fleet connection and no recorded
access choice migrate to `workers`; the next settings write persists that
choice. Explicit levels (including `portal`) stay unchanged. New registrations
and unknown hosts remain `portal`; SSH alone grants no shell or screen access.
Access refusals are retained per machine and required level and appear in
`clankie doctor` / `clankie doctor --machine FLEET --json`. The authenticated
read is `GET /v1/machines/access-refusals`, also available as
`clankie machines access-refusals --json`; it names the machine and owner fix.
Resolved refusals leave the doctor view after the owner's grant covers them.
