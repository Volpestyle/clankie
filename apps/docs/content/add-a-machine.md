# Add a machine

Let Clankie hire workers on another computer you own while his main service
stays where it is. A machine is a computer where work runs; a paired phone or
tablet is a device you use to talk to him.

Use an outbound join when the computer can reach your Clankie's gateway.
It needs no SSH alias or inbound port. The older SSH connection is still
available for an existing setup.

## Before you join

On the new computer, you need:

- The `clankie` CLI with join support. You do not need to run another Clankie
  service there. Windows setup is [below](#windows).
- [Herdr](https://herdr.dev) and the coding agents you want to use, installed
  and signed in under the account that will run the join. Open each agent once
  and finish its own setup first.
- A folder for the work, with the project's tools and repository available.
- An internet connection to the gateway your existing Clankie uses.

On the computer already running Clankie, use `clankie gateway status` to find
its gateway URL and `hostId`. If remote access is not connected, finish
[remote access setup](/get-started/#bring-your-mac-s-clankie-into-the-app) first.
Joining is separate from moving Clankie to another computer.

## Join and approve

On the **new computer**, replace the example URL, host ID and folder:

```sh
clankie join --gateway https://YOUR_GATEWAY --host HOST_ID --directory /absolute/project
```

Keep that terminal open. It shows a code that expires after five minutes.
Treat the code as a secret: do not paste it into a public chat, log or issue.

On the **computer already running Clankie**, approve the code from your owner
terminal. Use the exact folder advertised by the new computer:

```sh
clankie join approve CODE --access workers --directory /absolute/project
```

Only the owner can approve. Repeat `--directory` in both commands to offer and
approve more than one folder. Approval cannot add a folder the new computer
did not offer. The join reports its machine ID when it connects; keep that ID
for later commands.

## Choose how much access to give

Each level includes the levels above it:

| Level     | What you allow                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `portal`  | A connection to talk through; no work on this computer.                                                                             |
| `workers` | Hire coding agents into Herdr in approved folders.                                                                                  |
| `shell`   | Also run Clankie's own shell commands on this computer.                                                                             |
| `screen`  | Also request desktop observation and control, where a supported native helper is available. Screen sessions have their own consent. |

Start with **workers** for a coding computer. Choose portal if you only want
the connection; add shell or screen only when you need that kind of work.
These choices do not install missing tools, sign in to accounts or grant
operating-system permissions. Approved folders choose where work starts;
they do not sandbox an agent's shell.

On the home computer, you can lower a machine's access:

```sh
clankie machines access MACHINE_ID portal
```

You can restore access up to the level originally approved. To go beyond that
level or approve different folders, leave and join again with a new code.
Lowering access stops new actions above that level; it does not stop workers
already running.

## Check it works

On the home computer:

```sh
clankie machines
clankie doctor --machine MACHINE_ID
```

Replace `MACHINE_ID` with the joined machine's ID. Check that it is connected
and has the access you chose. `clankie doctor` on the home computer also gives
an overall diagnosis.

Then ask your lead: “On this machine, in this approved folder, hire one agent
to read the project README and report what it found. Don't change files.”
Look for its real terminal in Herdr on that computer and a report back to the
lead. A listed machine alone does not prove an agent can start.

## Disconnect, reconnect or remove

On the joined computer:

```sh
clankie join status
clankie join resume
```

Status reads the saved registration, not a fresh connection check. Resume
opens the connection again and stays running. Interrupting the foreground
join disconnects it without removing the approval. A running join retries
ordinary network outages on its own; a request whose answer was lost is not
replayed automatically.

To stop lending the computer, run there:

```sh
clankie join leave
```

Leave removes its local credential even when the home computer is offline.
If it says the home was not notified, remove the registration there once it is
reachable. You can also remove it from the home computer at any time:

```sh
clankie machines remove MACHINE_ID
```

Removal revokes the registration; reconnecting requires a new join and owner
approval. These commands do not close existing worker terminals for you.

## Windows

Windows can join a Clankie running on a Mac or Linux computer. There is no
Windows service installer yet; do not run the Mac/Linux install script in
PowerShell. You need a working CLI checkout on the PC, plus native Windows
Herdr and the signed-in harnesses you intend to use. WSL is a separate
environment; installing a harness there does not install its Windows version.

For a source CLI, install Git, Node 24+ and pnpm 11+, clone the
[repository](https://github.com/Volpestyle/clankie), and install its dependencies
with `pnpm install` in that checkout. You do not need to start its service.
From the checkout in PowerShell, check the join help, then start the receiver:

```powershell
pnpm exec tsx apps/tui/bin/clankie.ts join --help
pnpm exec tsx apps/tui/bin/clankie.ts join --gateway https://YOUR_GATEWAY --host HOST_ID --directory 'C:\Projects\my-project'
```

Approve the same Windows folder on the home computer, quoting it there too:

```sh
clankie join approve CODE --access workers --directory 'C:\Projects\my-project'
```

Use `pnpm exec tsx apps/tui/bin/clankie.ts` in place of `clankie` for status,
resume and leave on a source-only PC. Screen access additionally needs the
[native screen setup](https://github.com/Volpestyle/clankie/blob/main/docs/desktop-control.md#lend-a-joined-screen);
a screen-level approval by itself does not make it ready to drive.

## If it does not connect or hire

| What you see           | What to check                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Code expired           | Start a new join and approve its new code within five minutes.                                                                         |
| New joins are disabled | Ask the owner to check `clankie machines legacy-joins`; this setting controls new outbound joins too. Existing approvals keep working. |
| Computer disconnected  | Keep join or resume running, and check the gateway and the home computer's connection.                                                 |
| Access refused         | Read the machine's diagnosis. The owner must approve the required level; a worker cannot raise its own access.                         |
| Folder refused         | Use an offered, approved folder. To change that consent, leave and join again.                                                         |
| Agent does not start   | Open that harness locally, check its sign-in and Herdr, then read the hire's refusal before retrying. Do not resend an uncertain hire. |

## Existing SSH connections

If you already use SSH, it remains an option:

```sh
clankie machines add pc --ssh my-pc --shell powershell
```

This needs a working SSH connection, host-key trust and the remote tools. Use
`posix` instead of `powershell` for a POSIX shell. See the
[machine reference](/cli/#machines-list-discover-json) for discovery, sessions
and the legacy route, or the [join reference](/cli/#join) for the full outbound
connection contract.
