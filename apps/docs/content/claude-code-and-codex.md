# An AI that leads Claude Code and Codex agents

Give Clankie an outcome, a project folder and your working rules. The lead can
hire Claude Code and Codex workers, send follow-ups through their native
channels and collect their reports. Each worker runs in a real Herdr terminal
you can watch and use yourself.

You can use the built-in lead or [bring another lead](/diy/#bring-your-own-lead).
The project keeps its existing tracker: GitHub issues, Linear or local work
files. A fleet is a way to do the work, not a replacement for your repository.

## Prepare one computer first

[Install Clankie](/get-started/), install [Herdr](https://herdr.dev), and install
and sign in to Claude Code or Codex on the computer that will run them. Open
each harness once and complete its own setup and consent prompts. A
subscription remains that harness's subscription; workers do not inherit your
connected accounts just because they were hired.

Use `clankie doctor` to check setup. Start from an approved project folder.
When one computer works, [add another machine](/add-a-machine/) if you need it.

## Give a brief and a stopping point

For example:

> Fix this issue with Codex, then have a different agent review the result.
> Keep the work in this repository. Show me the tests and the pull request.
> Ask before merging or releasing.

These are example instructions, not a promise that a particular task has
passed. Say what completion means and which decisions you want to keep.
The lead chooses how to split the job and reports what each worker actually
proved. You can keep a small team for a small task.

## Keep control of the work

Use `/fleet` to choose working preferences such as team size, models, who may
commit or release, and how you want reports. `clankie fleet status` shows the
saved preferences. Projects can override them. Preferences guide the lead;
they do not create credentials, grant a worker machine access or replace a
harness's own permission controls.

A sent message is not proof of a finished change. Read the worker's result,
its evidence and the repository state before calling it done. If a hire or
message has an uncertain receipt, keep that receipt and inspect it instead of
starting a duplicate worker or resending the same brief.

## Find the worker

The console and app let you open worker conversations; Herdr holds the native
terminals. A report comes back to the lead even when you are elsewhere. Keep
the computer awake and the service running for remote access.

For supported harnesses and their limits, see the
[agent adapter guide](https://github.com/Volpestyle/clankie/blob/main/packages/agent-hosts/README.md).
For account and tool access, see
[worker access](https://github.com/Volpestyle/clankie/blob/main/docs/worker-access.md).
