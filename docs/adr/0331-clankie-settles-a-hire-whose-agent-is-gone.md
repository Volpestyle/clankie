# ADR 0331: Clankie settles a hire whose agent is gone

Status: Accepted, 2026-11-01. The owner chose it after stuck desktop hires
fenced every place on the Mac. Amends VUH-2243's operator-only settlement;
extends ADR 0207 and ADR 0319. Amended 2026-11-02 (#251): a hire whose pane
never appeared settles itself too, once it is five minutes old. Amended
2026-11-02 (#326): a hire on another machine whose only effect was an
unanswered workspace create settles itself from that machine's census.

## Context

A hire whose start never confirmed keeps an uncertain receipt, so a second
hire can't duplicate the first (ADR 0207). Until now only the owner could
settle one, with `clankie hire-receipt settle <id> abandoned`, which checks
this machine's complete inventory first: the original pane must be absent or
hold nothing but its shell. On the Mac, four desktop-app hires that had
already ended kept their places fenced until the owner settled each by hand,
and every new start there was refused in the meantime.

When the recorded pane is gone, or holds no harness, the first hire can't be
running, so a new hire can't duplicate it. The owner's step added nothing the
inventory hadn't already proved.

## Decision

- Before a new hire at a place on this machine (a Herdr pane or a desktop-app
  terminal), Clankie settles each unresolved earlier hire there whose recorded
  pane is absent from that runner's complete inventory or holds no harness,
  with the same census, double observation and evidence the operator's
  settlement takes.
- The recorded pane picks the inventory: a `herdr-core/` pane is checked
  against the desktop app's list, any other local pane against Herdr's. A pane
  on another machine is never settled this way.
- A hire that never recorded a pane settles the same way once it is five
  minutes old (#251), when no pane of its harness runs in its directory. Its
  project allocation, still without a pane, is then released through the
  operator's `release-allocation` census, which refuses while anything runs in
  that directory. A receipt or allocation from before start times were
  recorded counts its age from when the service loaded it.
- On another fleet machine, before a new hire at a place, Clankie settles each
  earlier hire there whose launch was committed but whose only effect was an
  unanswered workspace create, with no pane, session or occupant recorded
  (#326). No harness command left the service, so it settles as not launched,
  through the same authenticated host census and sealed journal
  (`launch-committed-command-unsent`) the operator's `not-launched` takes. A
  pane in the hire's directory there, as when the create landed late, keeps it
  fenced. New work at that place then goes as a fresh intent after it (#100),
  and the refusal names that intent.
- A hire still running, a younger one with no recorded pane, a fresh intent,
  any other remote hire, or one under operator recovery is left as it was; the
  owner's own settlement still covers those.
- Settling never closes, sends, relaunches or claims the brief arrived. The
  service log notes each one.

## Consequences

A place frees itself once its stuck hire's agent is gone, so leads and apps
stop seeing refusals that only the owner could clear. A launch that left no
pane record waits five minutes, long enough for any pane it drew to appear in
the inventory; after that the inventory rules it out as it does a gone pane.
An agent of that harness, or any pane in a project hire's directory, keeps the
place held for the owner or its lead to judge.

## Amendment: project allocations on remote failed starts (#326)

The native receipt can settle while its project allocation still fences the
folder. Recovery must therefore run before both the captain's checkout decision
and the store's project reservation. Ordinary remote project starts persist a
causal native receipt UUID and key before dispatch. After the host's immutable
not-launched seal, the same project's allocation can release automatically
through the existing complete double-census path. It must be inactive,
unobserved, uniquely linked and unchanged at the final locked write; current
conversation authority is checked across asynchronous evidence collection.

No timeout or current absence alone proves a dead launch. Legacy allocations
without that link, fresh intents, live or potentially starting workers and
changed evidence remain held for explicit recovery. The original launch history
is retained and its key remains fenced. This does not retry a hire or close a
pane. Loopback joined-machine coverage proves this service boundary; Windows/WSL
acceptance on real PCs remains separate.
