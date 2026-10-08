# ADR 0257: A lowered local runtime keeps an OS boundary

Status: Accepted for implementation (2026-10-08), VUH-1804. Extends ADR 0244.
Live activation and proof remain with the owner.

## Decision

Machine access levels continue to describe authority. A lower preference alone
is not a sandbox. On a self-hosted Mac, an owner can prepare a native Seatbelt
launch envelope for the installed service at portal, workers or shell level.
The launcher enters that envelope with `/usr/bin/sandbox-exec` before executing
Clankie. Children, including his private bundled Herdr and native workers,
inherit the kernel boundary. Unsupported platforms and invalid envelopes refuse
instead of starting an unrestricted replacement.

The envelope grants read-only access to the installed runtime and necessary OS
runtime files, and read/write access to explicit canonical workspace directories
and a private runtime home. Other file contents, owner Keychain/XPC services,
outside Unix sockets and control files are inaccessible. Network access is a
separate capability; this is not an exfiltration barrier or isolation from a
remote service an owner has independently authorized. File metadata remains
visible. Approved directory contents remain fully available to workers.

The immutable envelope, profile and a readable refusal probe live outside all
writable grants. A service proves that the ordinary same-user probe exists but
cannot be read before reporting an OS boundary. An environment variable is
only a locator, never proof. The service's authority ceiling cannot be raised
by changing its settings. An owner relaunch is required to change it.

An external Herdr cannot provide this guarantee: its already-running daemon
would launch workers outside the boundary. Lowered launches force a private
bundled fleet with a new socket namespace on every service start; they never
adopt an existing daemon. Named local connections also refuse; manual settings
insertion cannot restore their binding. Native worker controllers and panes therefore start
under the same inherited boundary. Existing unrestricted workers are not
retroactively confined and must be dealt with by the owner before activation.
A bounded service restart also creates a fresh fleet: surviving workers from its
previous daemon are not adopted. The owner must finish or manage those workers
before restarting; the service does not silently terminate them.

The owner prepares or removes the envelope from outside the bounded process,
then stops and starts the service. Removing it restores the ordinary full-access
launch without reinstalling. A running bounded process cannot remove its own
envelope; recovery must not silently drop it. Preparation does not restart the
service or alter OS settings. It makes a private copy of the service's non-secret
configuration; the owner provisions credentials needed inside that private
home. It does not grant the owner's Keychain, harness accounts or login files.
Preparation also does not migrate conversation, memory or pairing stores. The
owner must provision continuing service state with the service stopped before
activation; the original stores remain intact for the ordinary full launch.

## Limits and verification

`sandbox-exec` is deprecated in Apple's macOS manual. This is a native Seatbelt
process profile, not a signed App Sandbox application or a promise of a VM's
isolation. No global OS settings, TCC permissions, accounts or existing fleets
change. Screen access remains outside the lowered envelope. Broker-dependent
features refuse unless supported credentials are explicitly provisioned; they
must not broaden IPC permissions to regain owner access.

Integration evidence uses disposable directories and real native child
processes. It proves permitted reads/writes, denied outside reads, symlink
escape refusal, inherited worker refusal, protected control files, and a new
unrestricted child after envelope removal. No provider turn or live owner
service is used. The remaining owner proof is a deliberate lower/start/hire,
an outside-directory refusal from that real worker, and a stop/remove/start
showing restored access. Until then VUH-1804 stays open on that named gap.

References: the installed `sandbox-exec(1)` manual, ADR 0244 and ADR 0164.
