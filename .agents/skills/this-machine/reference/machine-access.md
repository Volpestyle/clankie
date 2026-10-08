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
proof and native worker/screen adapters remain VUH-1800 gaps. An authorized shell
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
proof remain the owner-held VUH-1804 gap. Apple's deprecated `sandbox-exec` is
the process boundary; do not describe it as a signed App Sandbox app or VM.

A joined receiver
must check its own owner-approved level and directory grants before executing
worker, shell or screen requests, regardless of what the sender claims.

Use `clankie join --gateway URL --host HOST_ID --directory PATH` on the joining
host. From an existing authenticated owner CLI/device approve its code with
`clankie join approve CODE --access LEVEL --directory PATH`. The code expires
in five minutes. It is generated locally with 256 bits of entropy; bootstrap
advertises only its hash. Copy it only to the existing trusted owner approval
surface; never record it in evidence. Keep the join command running. `join resume` restores approval;
`join status` is local registration status, not a live connection assertion.
`join leave` or `machines remove join-UUID` revokes it durably. A new join needs
new owner approval. Lease and machine exchanges are authenticated AES-256-GCM
envelopes with one-use challenges and independently keyed responses. The
gateway cannot read or forge work or broker capabilities. Never print or copy
its broker capability into evidence.
The gateway's machine routes require separate clankie-ops delivery; do not claim
production readiness from the loopback integration fixture.

Existing SSH machines with a saved enabled fleet connection and no recorded
access choice migrate to `workers`; the next settings write persists that
choice. Explicit levels (including `portal`) stay unchanged. New registrations
and unknown hosts remain `portal`; SSH alone grants no shell or screen access.
Access refusals are retained per machine and required level and appear in
`clankie doctor` / `clankie doctor --machine FLEET --json`. The authenticated
read is `GET /v1/machines/access-refusals`, also available as
`clankie machines access-refusals --json`; it names the machine and owner fix.
Resolved refusals leave the doctor view after the owner's grant covers them.
