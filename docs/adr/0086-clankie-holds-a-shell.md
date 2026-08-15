# ADR 0086: Clankie holds system tools only in trusted rooms

Status: accepted (James, 2026-08-09). Applies with
[ADR 0095](0095-discord-system-actors.md), which defines the active actor-level
boundary.

## Context

The pi captain can use shell and filesystem tools, but those tools execute as
the Clankie service's operating-system user. They are powerful machine tools,
not social capabilities. Discord message content remains untrusted even when
the sender is authorized to expose the tools.

## Decision

Pi's built-in `bash`, `read`, `edit`, and `write` tools are available only in:

- the operator lane; and
- Discord text turns whose actor id appears in `systemActorUserIds`.

All other Discord text turns stay social. Discord voice never receives system
tools. The host derives this tool set from authenticated lane and actor context;
prompt text cannot request or widen it.

The tools run directly in the `apps/clankie` service process. Repository
instructions, tool descriptions, and the actor gate are the active boundary.
Secrets remain in the credential broker and never enter repository files or
environment files.

## Consequences

- A trusted system actor can inspect and change the machine with the same OS
  authority as the Clankie service.
- A compromised system actor account exposes that authority; the allowlist must
  stay small and owner-authored.
- Untrusted Discord content remains untrusted input to the model. Tool exposure
  does not make channel text an instruction or an approval.
- Voice remains unable to run shell or filesystem operations.
